"""Background supervisor — poll gsd_status, diff progress, notify transitions."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.formatting import format_ref
from open_gsd_hermes.gsd_client import GsdMcpClient
from open_gsd_hermes.notifications import NotificationService
from open_gsd_hermes.types import DeliveryTarget, ProgressSnapshot, SessionStatus


class SupervisorState(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    BLOCKED = "blocked"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL = frozenset(
    {
        SupervisorState.COMPLETE,
        SupervisorState.FAILED,
        SupervisorState.CANCELLED,
    }
)


@dataclass
class SupervisorContext:
    session_id: str | None = None
    project_dir: str | None = None
    state: SupervisorState = SupervisorState.IDLE
    last_progress: ProgressSnapshot | None = None
    last_status: SessionStatus | None = None
    pending_blocker_id: str | None = None
    notified_terminal: bool = False


class SupervisorFsm:
    """Poll loop with transition detection for unit/blocker/terminal changes."""

    def __init__(
        self,
        config: GsdConfig,
        client: GsdMcpClient,
        notifications: NotificationService,
        get_context: Callable[[], SupervisorContext],
        set_context: Callable[[SupervisorContext], None],
    ) -> None:
        self._config = config
        self._client = client
        self._notifications = notifications
        self._get_context = get_context
        self._set_context = set_context
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        # Captured in start() on the bound command thread; the loop thread
        # has no session binding, so its sends must use this snapshot.
        self._target: DeliveryTarget | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._target = self._notifications.resolve_target()
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._loop,
            args=(self._stop,),
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=5)
        self._thread = None

    def _loop(self, stop_event: threading.Event) -> None:
        try:
            while not stop_event.is_set():
                try:
                    self._tick(stop_event)
                except Exception:
                    pass
                stop_event.wait(self._config.poll_interval_seconds)
        finally:
            if self._thread is threading.current_thread():
                self._thread = None

    def _tick(self, stop_event: threading.Event | None = None) -> None:
        if stop_event is None:
            stop_event = self._stop
        ctx = self._get_context()
        if not ctx.session_id or not ctx.project_dir:
            return

        status = self._client.status(ctx.session_id)
        try:
            progress = self._client.progress(ctx.project_dir)
        except Exception:
            progress = None
        ctx.last_status = status
        blocker_notification: SessionStatus | None = None
        terminal_notification: tuple[str, str | None] | None = None

        new_state = self._map_status(status.status)
        pending_blocker_id = (
            (status.pending_blocker or {}).get("id")
            or (status.pending_blocker or {}).get("blockerId")
        )
        if (
            status.pending_blocker
            and new_state not in TERMINAL
            and new_state != SupervisorState.BLOCKED
        ):
            new_state = SupervisorState.BLOCKED

        if new_state != ctx.state:
            ctx.state = new_state
            if new_state == SupervisorState.BLOCKED:
                blocker_notification = status
            elif new_state in TERMINAL and not ctx.notified_terminal:
                ctx.notified_terminal = True
                terminal_notification = (status.status, status.error)
        elif (
            new_state == SupervisorState.BLOCKED
            and pending_blocker_id
            and pending_blocker_id != ctx.pending_blocker_id
        ):
            blocker_notification = status

        if new_state == SupervisorState.BLOCKED:
            ctx.pending_blocker_id = pending_blocker_id

        if progress is not None:
            self._diff_progress(ctx, progress)
            ctx.last_progress = progress
        if terminal_notification:
            stop_event.set()
        self._set_context(ctx)
        if blocker_notification:
            self._notifications.notify_blocker(
                blocker_notification, target=self._target
            )
        if terminal_notification:
            self._notifications.notify_terminal(
                *terminal_notification, target=self._target
            )

    def _map_status(self, raw: str) -> SupervisorState:
        mapping = {
            "running": SupervisorState.RUNNING,
            "blocked": SupervisorState.BLOCKED,
            "complete": SupervisorState.COMPLETE,
            "completed": SupervisorState.COMPLETE,
            "done": SupervisorState.COMPLETE,
            "failed": SupervisorState.FAILED,
            "error": SupervisorState.FAILED,
            "cancelled": SupervisorState.CANCELLED,
        }
        return mapping.get(raw.lower(), SupervisorState.RUNNING)

    def _diff_progress(
        self, ctx: SupervisorContext, progress: ProgressSnapshot
    ) -> None:
        prev = ctx.last_progress
        if prev is None:
            return
        parts: list[str] = []
        for label, old, new in (
            ("milestone", prev.active_milestone, progress.active_milestone),
            ("slice", prev.active_slice, progress.active_slice),
            ("task", prev.active_task, progress.active_task),
        ):
            if old != new and new:
                parts.append(f"{label} → {format_ref(new, include_title=False)}")
        if parts:
            self._notifications.notify_transition(
                ", ".join(parts), target=self._target
            )
            self._client.invalidate_cache(ctx.project_dir)
