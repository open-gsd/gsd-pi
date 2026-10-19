"""Supervisor FSM transition tests with mock MCP."""

from __future__ import annotations

import asyncio
import threading
from unittest.mock import MagicMock

import pytest

from open_gsd_hermes.binding import SessionBindStore
from open_gsd_hermes.commands import GsdCommandRouter
from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import McpProtocolError
from open_gsd_hermes.notifications import NotificationService
from open_gsd_hermes.supervisor import SupervisorContext, SupervisorFsm, SupervisorState
from open_gsd_hermes.types import (
    BindingContext,
    DeliveryTarget,
    ProgressSnapshot,
    SessionStatus,
)


class MockClient:
    def __init__(self) -> None:
        self.status_calls = 0
        self._status = SessionStatus(status="running")
        self._progress = ProgressSnapshot(phase="execute")
        self.invalidated: list[str | None] = []

    def status(self, _session_id: str) -> SessionStatus:
        self.status_calls += 1
        return self._status

    def progress(self, _project_dir: str) -> ProgressSnapshot:
        return self._progress

    def invalidate_cache(self, _project_dir: str | None = None) -> None:
        self.invalidated.append(_project_dir)


class MockSupervisor:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.calls: list[str] = []

    def start(self) -> None:
        self.started = True
        self.calls.append("start")

    def stop(self) -> None:
        self.stopped = True
        self.calls.append("stop")


def build_router(tmp_path, client, supervisor=None, ctx=None, notifications=None):
    project_dir = tmp_path / "project"
    (project_dir / ".gsd").mkdir(parents=True, exist_ok=True)
    if supervisor is None:
        supervisor = MockSupervisor()
    if ctx is None:
        ctx = SupervisorContext()
    stored: list[SupervisorContext] = []
    router = GsdCommandRouter(
        GsdConfig(default_project=str(project_dir)),
        client,
        SessionBindStore(),
        supervisor,  # type: ignore[arg-type]
        lambda: "session-key",
        lambda: BindingContext(),
        lambda: ctx,
        stored.append,
        lambda: (None, None),
        notifications,
    )
    return router, project_dir, supervisor, ctx, stored


def test_supervisor_restart_keeps_abandoned_thread_stop_event_set() -> None:
    fsm = SupervisorFsm(
        GsdConfig(poll_interval_seconds=1),
        MagicMock(),
        MagicMock(),
        lambda: SupervisorContext(),
        lambda c: None,
    )
    abandoned_stop = fsm._stop
    abandoned_stop.set()
    fsm._thread = None

    fsm.start()

    try:
        assert abandoned_stop.is_set()
        assert fsm._stop is not abandoned_stop
    finally:
        fsm.stop()


def test_bind_rejects_invalid_path_instead_of_falling_back_to_default(tmp_path) -> None:
    project_dir = tmp_path / "project"
    (project_dir / ".gsd").mkdir(parents=True)
    bind_store = SessionBindStore()
    client = MagicMock()

    router = GsdCommandRouter(
        GsdConfig(default_project=str(project_dir)),
        client,
        bind_store,
        MockSupervisor(),  # type: ignore[arg-type]
        lambda: "session-key",
        lambda: BindingContext(),
        lambda: SupervisorContext(),
        lambda c: None,
        lambda: (None, None),
    )

    result = asyncio.run(router._cmd_bind([str(tmp_path / "missing")]))

    assert "is not a GSD project" in result
    assert bind_store.get("session-key") is None
    client.invalidate_cache.assert_not_called()


def test_auto_resets_session_specific_supervisor_context(tmp_path) -> None:
    project_dir = tmp_path / "project"
    (project_dir / ".gsd").mkdir(parents=True)
    ctx = SupervisorContext(
        session_id="old-session",
        project_dir="/tmp/old",
        state=SupervisorState.COMPLETE,
        last_progress=ProgressSnapshot(active_task={"id": "old-task"}),
        last_status=SessionStatus(status="complete"),
        pending_blocker_id="old-blocker",
        notified_terminal=True,
    )
    supervisor = MockSupervisor()
    client = MagicMock()
    client.milestone_active.return_value = False
    client.execute.return_value = {"sessionId": "new-session"}

    router = GsdCommandRouter(
        GsdConfig(default_project=str(project_dir)),
        client,
        SessionBindStore(),
        supervisor,  # type: ignore[arg-type]
        lambda: "session-key",
        lambda: BindingContext(),
        lambda: ctx,
        lambda c: None,
        lambda: (None, None),
    )

    result = asyncio.run(router._cmd_auto([]))

    assert result == "Started GSD auto mode (session `new-session`)"
    assert supervisor.started
    assert supervisor.calls == ["stop", "start"]
    assert ctx.session_id == "new-session"
    assert ctx.project_dir == str(project_dir)
    assert ctx.state == SupervisorState.RUNNING
    assert ctx.last_progress is None
    assert ctx.last_status is None
    assert ctx.pending_blocker_id is None
    assert not ctx.notified_terminal


def test_status_returns_friendly_message_when_mcp_progress_fails(tmp_path) -> None:
    client = MagicMock()
    client.progress.side_effect = McpProtocolError("sidecar unavailable")
    router, _project_dir, _supervisor, _ctx, _stored = build_router(tmp_path, client)

    result = asyncio.run(router._cmd_status([]))

    assert result == "GSD status unavailable: sidecar unavailable"


def test_auto_returns_friendly_message_when_mcp_execute_fails(tmp_path) -> None:
    supervisor = MockSupervisor()
    client = MagicMock()
    client.milestone_active.return_value = False
    client.execute.side_effect = McpProtocolError("sidecar unavailable")
    router, _project_dir, _supervisor, _ctx, _stored = build_router(
        tmp_path, client, supervisor=supervisor
    )

    result = asyncio.run(router._cmd_auto([]))

    assert result == "Could not start GSD auto mode: sidecar unavailable"
    assert supervisor.calls == []


def test_auto_rejects_missing_session_id_in_mcp_response(tmp_path) -> None:
    supervisor = MockSupervisor()
    client = MagicMock()
    client.milestone_active.return_value = False
    client.execute.return_value = {}
    router, _project_dir, _supervisor, ctx, _stored = build_router(
        tmp_path, client, supervisor=supervisor
    )

    result = asyncio.run(router._cmd_auto([]))

    assert result == "Could not start GSD auto mode: missing session ID"
    assert supervisor.calls == []
    assert ctx.session_id is None
    assert ctx.state == SupervisorState.IDLE


def test_cancel_stops_supervisor_when_mcp_cancel_fails(tmp_path) -> None:
    supervisor = MockSupervisor()
    client = MagicMock()
    client.milestone_active.return_value = False
    client.cancel_by_project.side_effect = McpProtocolError("sidecar unavailable")
    router, _project_dir, _supervisor, ctx, stored = build_router(
        tmp_path, client, supervisor=supervisor
    )

    result = asyncio.run(router._cmd_cancel([]))

    assert result == "Cancel request failed: sidecar unavailable"
    assert supervisor.calls == ["stop"]
    assert ctx.state == SupervisorState.CANCELLED
    assert stored == [ctx]


def test_cancel_sends_terminal_notification_after_successful_mcp_cancel(tmp_path) -> None:
    supervisor = MockSupervisor()
    notifications = MagicMock()
    client = MagicMock()
    client.milestone_active.return_value = False
    ctx = SupervisorContext(
        session_id="s1",
        state=SupervisorState.RUNNING,
    )
    router, project_dir, _supervisor, ctx, stored = build_router(
        tmp_path,
        client,
        supervisor=supervisor,
        ctx=ctx,
        notifications=notifications,
    )

    result = asyncio.run(router._cmd_cancel([]))

    assert result == "Cancel requested."
    client.cancel.assert_called_once_with(
        session_id="s1",
        project_dir=str(project_dir),
    )
    notifications.notify_terminal.assert_called_once_with("cancelled")
    assert supervisor.calls == ["stop"]
    assert ctx.state == SupervisorState.CANCELLED
    assert ctx.notified_terminal
    assert stored == [ctx]


def test_cancel_prefers_supervisor_project_for_active_session(tmp_path) -> None:
    current_project = tmp_path / "current"
    current_project.mkdir()
    (current_project / ".gsd").mkdir()
    running_project = tmp_path / "running"
    running_project.mkdir()
    (running_project / ".gsd").mkdir()
    supervisor = MockSupervisor()
    client = MagicMock()
    client.milestone_active.return_value = False
    ctx = SupervisorContext(
        session_id="s1",
        project_dir=str(running_project),
        state=SupervisorState.RUNNING,
    )
    stored: list[SupervisorContext] = []
    router = GsdCommandRouter(
        GsdConfig(default_project=str(current_project)),
        client,
        SessionBindStore(),
        supervisor,  # type: ignore[arg-type]
        lambda: "session-key",
        lambda: BindingContext(),
        lambda: ctx,
        stored.append,
        lambda: (None, None),
    )

    result = asyncio.run(router._cmd_cancel([]))

    assert result == "Cancel requested."
    client.cancel.assert_called_once_with(
        session_id="s1",
        project_dir=str(running_project),
    )


def test_cancel_stops_supervisor_when_binding_resolution_fails(tmp_path) -> None:
    supervisor = MockSupervisor()
    client = MagicMock()
    client.milestone_active.return_value = False
    ctx = SupervisorContext(
        session_id="s1",
        project_dir=str(tmp_path / "missing"),
        state=SupervisorState.RUNNING,
    )
    bind_store = SessionBindStore()
    bind_store.set("session-key", str(tmp_path / "missing"))
    stored: list[SupervisorContext] = []
    router = GsdCommandRouter(
        GsdConfig(default_project=None),
        client,
        bind_store,
        supervisor,  # type: ignore[arg-type]
        lambda: "session-key",
        lambda: BindingContext(),
        lambda: ctx,
        stored.append,
        lambda: (None, None),
    )

    result = asyncio.run(router._cmd_cancel([]))

    assert "is not a GSD project" in result
    client.cancel.assert_not_called()
    client.cancel_by_project.assert_not_called()
    assert supervisor.calls == ["stop"]
    assert ctx.state == SupervisorState.CANCELLED
    assert stored == [ctx]


def test_reply_returns_friendly_message_when_mcp_resolve_fails(tmp_path) -> None:
    client = MagicMock()
    client.milestone_active.return_value = False
    client.resolve_blocker.side_effect = McpProtocolError("sidecar unavailable")
    ctx = SupervisorContext(session_id="s1", project_dir="/tmp/project")
    router, _project_dir, _supervisor, _ctx, _stored = build_router(
        tmp_path, client, ctx=ctx
    )

    result = asyncio.run(router._cmd_reply(["hello"]))

    assert result == "Could not send blocker response: sidecar unavailable"
    client.invalidate_cache.assert_not_called()


def test_supervisor_detects_blocker() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
    )
    client = MockClient()
    client._status = SessionStatus(
        status="running",
        pending_blocker={"id": "b1", "question": "Approve deploy?"},
    )
    sent: list[str] = []

    def dispatch(_name: str, args: dict) -> None:
        sent.append(args.get("text", ""))

    target = DeliveryTarget("slack", "channel", "C123")
    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: target,
        dispatch=dispatch,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        lambda c: None,
    )
    fsm._tick()
    assert ctx.state == SupervisorState.BLOCKED
    assert any("blocker" in t.lower() or "Approve" in t for t in sent)


def test_notify_blocker_prefers_title_over_generic_message() -> None:
    sent: list[str] = []

    def dispatch(_name: str, args: dict) -> None:
        sent.append(args.get("text", ""))

    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: DeliveryTarget("slack", "channel", "C123"),
        dispatch=dispatch,
    )

    notifications.notify_blocker(
        SessionStatus(
            status="blocked",
            pending_blocker={
                "type": "extension_ui_request",
                "method": "select",
                "id": "sel-1",
                "title": "Choose milestone scope",
                "message": "Action required",
                "options": ["A", "B"],
            },
        )
    )

    assert len(sent) == 1
    assert "GSD blocker: Choose milestone scope" in sent[0]
    assert "GSD blocker: Action required" not in sent[0]


def test_supervisor_terminal_tick_updates_progress_before_stopping() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
        last_progress=ProgressSnapshot(
            active_task={"id": "old-task"},
            phase="execute",
        ),
    )
    client = MockClient()
    client._status = SessionStatus(status="complete")
    client._progress = ProgressSnapshot(
        active_task={"id": "new-task"},
        phase="complete",
    )
    stored: list[SupervisorContext] = []
    sent: list[str] = []

    def dispatch(_name: str, args: dict) -> None:
        sent.append(args.get("text", ""))

    target = DeliveryTarget("slack", "channel", "C123")
    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: target,
        dispatch=dispatch,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        stored.append,
    )
    fsm._thread = threading.current_thread()

    fsm._tick()

    assert fsm._stop.is_set()
    assert ctx.notified_terminal
    assert ctx.last_progress == client._progress
    assert stored == [ctx]
    assert any("finished" in t for t in sent)
    assert any("new-task" in t for t in sent)
    assert sent == [
        "📋 GSD: task → new-task",
        "✅ GSD auto mode finished.",
    ]


def test_supervisor_terminal_status_takes_precedence_over_pending_blocker() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.BLOCKED,
    )
    client = MockClient()
    client._status = SessionStatus(
        status="Completed",
        pending_blocker={"id": "b1", "question": "Approve deploy?"},
    )
    stored: list[SupervisorContext] = []
    sent: list[str] = []

    def dispatch(_name: str, args: dict) -> None:
        sent.append(args.get("text", ""))

    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: DeliveryTarget("slack", "channel", "C123"),
        dispatch=dispatch,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        stored.append,
    )
    fsm._thread = threading.current_thread()

    fsm._tick()

    assert ctx.state == SupervisorState.COMPLETE
    assert ctx.notified_terminal
    assert fsm._stop.is_set()
    assert stored == [ctx]
    assert sent == ["✅ GSD auto mode finished."]


def test_supervisor_notifies_new_blocker_while_already_blocked() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.BLOCKED,
        pending_blocker_id="b1",
    )
    client = MockClient()
    client._status = SessionStatus(
        status="running",
        pending_blocker={"id": "b2", "question": "Choose option?"},
    )
    notifications = MagicMock()
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        lambda c: None,
    )

    fsm._tick()

    assert ctx.pending_blocker_id == "b2"
    notifications.notify_blocker.assert_called_once_with(client._status, target=None)


def test_supervisor_terminal_status_notifies_even_when_progress_fails() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
    )
    client = MagicMock()
    client.status.return_value = SessionStatus(status="complete")
    client.progress.side_effect = RuntimeError("read failed")
    notifications = MagicMock()
    stored: list[SupervisorContext] = []
    fsm = SupervisorFsm(
        GsdConfig(),
        client,
        notifications,
        lambda: ctx,
        stored.append,
    )

    fsm._tick()

    assert fsm._stop.is_set()
    assert ctx.state == SupervisorState.COMPLETE
    assert ctx.notified_terminal
    assert stored == [ctx]
    notifications.notify_terminal.assert_called_once_with("complete", None, target=None)


def test_supervisor_terminal_notification_failure_still_stops() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
    )
    client = MockClient()
    client._status = SessionStatus(status="complete")
    notifications = MagicMock()
    notifications.notify_terminal.side_effect = RuntimeError("dispatch failed")
    stored: list[SupervisorContext] = []
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        stored.append,
    )

    with pytest.raises(RuntimeError, match="dispatch failed"):
        fsm._tick()

    assert fsm._stop.is_set()
    assert ctx.notified_terminal
    assert stored == [ctx]


def test_supervisor_keeps_cache_when_progress_unchanged() -> None:
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/tmp/p",
        state=SupervisorState.RUNNING,
        last_progress=ProgressSnapshot(
            active_task={"id": "same-task"},
            phase="execute",
        ),
    )
    client = MockClient()
    client._status = SessionStatus(status="running")
    client._progress = ProgressSnapshot(
        active_task={"id": "same-task"},
        phase="execute",
    )

    notifications = NotificationService(
        MagicMock(),
        GsdConfig(),
        lambda: DeliveryTarget("slack", "channel", "C123"),
        dispatch=lambda _name, _args: None,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        notifications,
        lambda: ctx,
        lambda c: None,
    )

    fsm._tick()

    assert client.invalidated == []
