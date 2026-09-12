"""Regression tests for issue #2288: async notifications silently dropped.

Async senders (supervisor FSM poll loop, milestone stream reader) run on
plain threads where no session key is bound, so live target resolution
returns None there. The delivery target must be captured on the bound
command thread at thread spawn and passed explicitly to send(); live
resolution (command-path callers) still wins when no target is passed.
"""

from __future__ import annotations

import threading
from typing import Any, Callable
from unittest.mock import MagicMock

import pytest

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.notifications import NotificationService
from open_gsd_hermes.session_key import (
    bind_session_key,
    reset_session_key,
    resolve_session_key,
)
from open_gsd_hermes.supervisor import SupervisorContext, SupervisorFsm, SupervisorState
from open_gsd_hermes.types import (
    DeliveryTarget,
    ProgressSnapshot,
    SessionStatus,
)


def _live_get_target() -> DeliveryTarget | None:
    """Mirror register()'s get_target closure: live session key → target."""
    key = resolve_session_key()
    if not key:
        return None
    return DeliveryTarget.from_session_key(key)


def _make_service(
    get_target: Callable[[], DeliveryTarget | None],
) -> tuple[NotificationService, list[dict[str, Any]]]:
    dispatched: list[dict[str, Any]] = []

    def dispatch(_name: str, args: dict[str, Any]) -> None:
        dispatched.append(args)

    service = NotificationService(
        MagicMock(),
        GsdConfig(),
        get_target,
        dispatch=dispatch,
    )
    return service, dispatched


def _run_on_thread(fn: Callable[[], Any]) -> Any:
    """Run fn on a fresh thread and re-raise its exception on the caller."""
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            box["result"] = fn()
        except Exception as e:
            box["error"] = e

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box.get("result")


def _capture_on_bound_thread(service: NotificationService, key: str) -> DeliveryTarget:
    """Resolve the target as a spawn site does on the bound command thread."""
    token = bind_session_key(key)
    try:
        target = service.resolve_target()
    finally:
        reset_session_key(token)
    assert target is not None
    return target


class _FakeSupervisorClient:
    def __init__(self, status: SessionStatus) -> None:
        self._status = status

    def status(self, _session_id: str) -> SessionStatus:
        return self._status

    def progress(self, _project_dir: str) -> ProgressSnapshot:
        return ProgressSnapshot(phase="execute")

    def invalidate_cache(self, _project_dir: str | None = None) -> None:
        pass


def test_send_with_target_captured_on_bound_thread_delivers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Core #2288: a worker send with the spawn-captured target delivers."""
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    service, dispatched = _make_service(_live_get_target)

    captured = _capture_on_bound_thread(service, "agent:main:slack:channel:C1")

    delivered = _run_on_thread(
        lambda: service.send("done", kind="complete", target=captured)
    )
    assert delivered is True
    assert dispatched == [
        {
            "platform": "slack",
            "chat_type": "channel",
            "chat_id": "C1",
            "text": "done",
        }
    ]


def test_worker_keeps_starting_chat_after_another_chat_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Chat B's later command must not redirect chat A's worker sends.

    Both chats share one service (as in register()); only each run's own
    spawn-time capture may be used, so per-run passing — never a shared
    stash updated by every command — keeps A's worker on A. A worker with
    no capture of its own must not inherit B's target either.
    """
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    service, dispatched = _make_service(_live_get_target)

    target_a = _capture_on_bound_thread(service, "agent:main:slack:channel:C_A")
    _capture_on_bound_thread(service, "agent:main:slack:channel:C_B")

    delivered = _run_on_thread(
        lambda: service.send("done", kind="complete", target=target_a)
    )
    assert delivered is True
    assert dispatched[0]["chat_id"] == "C_A"

    # No shared fallback: an uncaptured worker send must not deliver to B.
    leaked = _run_on_thread(lambda: service.send("done", kind="complete"))
    assert leaked is False
    assert len(dispatched) == 1


def test_worker_uses_captured_target_not_env_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The env fallback must not override the command-thread capture.

    An unbound worker under an env value would still resolve "live" — the
    explicit capture must win instead.
    """
    monkeypatch.setenv("HERMES_SESSION_KEY", "agent:main:cli:direct:env")
    service, dispatched = _make_service(_live_get_target)

    captured = _capture_on_bound_thread(service, "agent:main:slack:channel:C_gw")
    assert captured.chat_id == "C_gw"

    delivered = _run_on_thread(
        lambda: service.send("done", kind="complete", target=captured)
    )
    assert delivered is True
    assert dispatched[0]["chat_id"] == "C_gw"


def test_send_without_any_target_returns_false_and_logs(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    service, dispatched = _make_service(_live_get_target)

    with caplog.at_level("WARNING", logger="open_gsd_hermes.notifications"):
        delivered = service.send("lost", kind="complete")

    assert delivered is False
    assert dispatched == []
    assert any("target" in record.message.lower() for record in caplog.records)


def test_send_without_explicit_target_still_resolves_live(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Command-path callers keep live resolution (unchanged semantics)."""
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    service, dispatched = _make_service(_live_get_target)

    token = bind_session_key("agent:main:slack:channel:C_live")
    try:
        delivered = service.send("hi", kind="complete")
    finally:
        reset_session_key(token)

    assert delivered is True
    assert dispatched[0]["chat_id"] == "C_live"


def test_supervisor_delivers_to_target_captured_at_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SupervisorFsm.start() captures the target; its loop delivers to it.

    Whether the loop's own first tick or a later unbound tick fires the
    blocker notification, exactly one delivery happens and it goes to the
    chat captured on the bound starting thread.
    """
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)
    service, dispatched = _make_service(_live_get_target)
    client = _FakeSupervisorClient(
        SessionStatus(
            status="blocked",
            pending_blocker={"id": "b1", "question": "Approve?"},
        )
    )
    ctx = SupervisorContext(
        session_id="s1",
        project_dir="/proj",
        state=SupervisorState.RUNNING,
    )
    fsm = SupervisorFsm(
        GsdConfig(),
        client,  # type: ignore[arg-type]
        service,
        lambda: ctx,
        lambda c: None,
    )

    token = bind_session_key("agent:main:slack:channel:C_A")
    try:
        fsm.start()
    finally:
        reset_session_key(token)
    fsm.stop()

    _run_on_thread(fsm._tick)

    assert len(dispatched) == 1
    assert dispatched[0]["chat_id"] == "C_A"
    assert dispatched[0]["platform"] == "slack"
