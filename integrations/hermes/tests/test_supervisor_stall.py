"""Stall watchdog: one notification + one jsonl line per stall, reset on progress."""

from __future__ import annotations

import json
import time

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.supervisor import SupervisorContext, SupervisorFsm, SupervisorState
from open_gsd_hermes.types import ProgressSnapshot, SessionStatus


class FakeClient:
    def __init__(self) -> None:
        self._status = SessionStatus(status="running")
        self._progress = ProgressSnapshot(
            phase="execute",
            active_milestone={"id": "M001"},
            active_slice={"id": "S002"},
            active_task={"id": "T003"},
        )
        self.invalidated: list[str | None] = []

    def status(self, _session_id: str) -> SessionStatus:
        return self._status

    def progress(self, _project_dir: str) -> ProgressSnapshot:
        return self._progress

    def invalidate_cache(self, project_dir: str | None = None) -> None:
        self.invalidated.append(project_dir)


class FakeNotifications:
    def __init__(self) -> None:
        self.stalls: list[tuple[str, int, str]] = []
        self.transitions: list[str] = []
        self.blockers: list[SessionStatus] = []
        self.terminals: list[tuple[str, str | None]] = []

    def notify_stall(self, where: str, idle_minutes: int, doctor_head: str = "", target=None) -> None:
        self.stalls.append((where, idle_minutes, doctor_head))

    def notify_transition(self, message: str, target=None) -> None:
        self.transitions.append(message)

    def notify_blocker(self, status, target=None) -> None:
        self.blockers.append(status)

    def notify_terminal(self, status, error=None, target=None) -> None:
        self.terminals.append((status, error))


def build(tmp_path, stall_minutes: int = 20):
    project_dir = tmp_path / "project"
    (project_dir / ".gsd").mkdir(parents=True)
    client = FakeClient()
    notifications = FakeNotifications()
    ctx = SupervisorContext(
        session_id="s-1",
        project_dir=str(project_dir),
        state=SupervisorState.RUNNING,
        last_progress=client._progress,
    )
    # cli_path empty => no `gsd doctor` subprocess in tests
    fsm = SupervisorFsm(
        GsdConfig(cli_path="", stall_minutes=stall_minutes),
        client,  # type: ignore[arg-type]
        notifications,  # type: ignore[arg-type]
        lambda: ctx,
        lambda c: None,
    )
    return fsm, ctx, client, notifications, project_dir


def stall_lines(project_dir) -> list[dict]:
    log = project_dir / ".gsd" / "stall-log.jsonl"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


def test_running_without_progress_past_threshold_notifies_once(tmp_path) -> None:
    fsm, ctx, _client, notifications, project_dir = build(tmp_path)
    ctx.last_change_at = time.monotonic() - 25 * 60

    fsm._tick()
    fsm._tick()  # still stalled — must not repeat

    assert len(notifications.stalls) == 1
    where, idle, _doctor = notifications.stalls[0]
    assert where == "milestone M001, slice S002, task T003"
    assert idle == 25
    assert ctx.stall_notified is True

    lines = stall_lines(project_dir)
    assert len(lines) == 1
    assert lines[0]["mid"] == "M001"
    assert lines[0]["sid"] == "S002"
    assert lines[0]["tid"] == "T003"
    assert lines[0]["idle_minutes"] == 25


def test_progress_resets_and_a_later_stall_notifies_again(tmp_path) -> None:
    fsm, ctx, client, notifications, project_dir = build(tmp_path)
    ctx.last_change_at = time.monotonic() - 25 * 60
    fsm._tick()
    assert len(notifications.stalls) == 1

    client._progress = ProgressSnapshot(
        phase="execute",
        active_milestone={"id": "M001"},
        active_slice={"id": "S002"},
        active_task={"id": "T004"},
    )
    fsm._tick()  # progress moved -> reset
    assert ctx.stall_notified is False
    assert len(notifications.stalls) == 1

    ctx.last_change_at = time.monotonic() - 30 * 60
    fsm._tick()

    assert len(notifications.stalls) == 2
    assert notifications.stalls[1][0].endswith("task T004")
    assert len(stall_lines(project_dir)) == 2


def test_below_threshold_notifies_nothing(tmp_path) -> None:
    fsm, ctx, _client, notifications, project_dir = build(tmp_path)
    ctx.last_change_at = time.monotonic() - 5 * 60

    fsm._tick()

    assert notifications.stalls == []
    assert stall_lines(project_dir) == []


def test_blocked_past_threshold_does_not_stall(tmp_path) -> None:
    """Maintainer addition on #2210: no stall on top of an active blocked notification.

    A session waiting on an operator reply is idle by design, and the operator
    already has notify_blocker. Only a RUNNING session can be called stalled.
    """
    fsm, ctx, client, notifications, project_dir = build(tmp_path)
    client._status = SessionStatus(status="blocked", pending_blocker={"id": "b-1"})

    fsm._tick()  # running -> blocked, one blocker notification
    assert len(notifications.blockers) == 1
    assert ctx.state is SupervisorState.BLOCKED

    # 40 minutes go by with the blocker still pending and nothing else moving.
    ctx.last_change_at = time.monotonic() - 40 * 60
    fsm._tick()
    fsm._tick()

    assert notifications.stalls == []
    assert stall_lines(project_dir) == []
    assert ctx.stall_notified is False
    assert len(notifications.blockers) == 1  # blocker is not re-sent either


def test_resumed_after_blocker_restarts_the_timer(tmp_path) -> None:
    """Time spent blocked is not counted toward the next stall."""
    fsm, ctx, client, notifications, project_dir = build(tmp_path)
    client._status = SessionStatus(status="blocked", pending_blocker={"id": "b-1"})
    fsm._tick()
    ctx.last_change_at = time.monotonic() - 40 * 60
    fsm._tick()
    assert notifications.stalls == []

    # Operator answers: status goes back to running and the task advances.
    client._status = SessionStatus(status="running")
    client._progress = ProgressSnapshot(
        phase="execute",
        active_milestone={"id": "M001"},
        active_slice={"id": "S002"},
        active_task={"id": "T004"},
    )
    before = time.monotonic()
    fsm._tick()

    # The resume tick saw idle > threshold, but the state/progress change wins:
    # the timer restarts and nothing is reported as stalled.
    assert ctx.state is SupervisorState.RUNNING
    assert ctx.last_change_at >= before
    assert ctx.stall_notified is False
    assert notifications.stalls == []
    fsm._tick()
    assert notifications.stalls == []

    # A fresh 25-minute silence after the resume does fire, once.
    ctx.last_change_at = time.monotonic() - 25 * 60
    fsm._tick()
    fsm._tick()

    assert len(notifications.stalls) == 1
    assert notifications.stalls[0][0].endswith("task T004")
    assert len(stall_lines(project_dir)) == 1
