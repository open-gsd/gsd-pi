"""Background supervisor — poll gsd_status, diff progress, notify transitions."""

from __future__ import annotations

import json
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
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
    last_change_at: float = field(default_factory=time.monotonic)
    stall_notified: bool = False


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

        changed = False
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
            changed = True
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
            if self._diff_progress(ctx, progress):
                changed = True
            ctx.last_progress = progress

        idle = time.monotonic() - ctx.last_change_at
        stall_minutes: int | None = None
        if changed:
            ctx.last_change_at = time.monotonic()
            ctx.stall_notified = False
        elif (
            # Requiring RUNNING is what suppresses the stall notification while a
            # blocked or terminal notification is already active: BLOCKED and the
            # TERMINAL states are exactly the states that carry their own
            # notify_blocker/notify_terminal message, and a session waiting on an
            # operator reply is idle by design, not wedged. Only a session that is
            # supposed to be progressing can be called stalled.
            ctx.state == SupervisorState.RUNNING
            and not ctx.stall_notified
            and idle > self._config.stall_minutes * 60
        ):
            ctx.stall_notified = True
            stall_minutes = int(idle // 60)

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
        if stall_minutes is not None:
            self._notify_stall(ctx, stall_minutes)

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

    def _notify_stall(self, ctx: SupervisorContext, idle_minutes: int) -> None:
        """One notification + one .gsd/stall-log.jsonl line per stall."""
        p = ctx.last_progress or ProgressSnapshot()
        units = [
            (label, ref)
            for label, ref in (
                ("milestone", p.active_milestone),
                ("slice", p.active_slice),
                ("task", p.active_task),
            )
            if ref
        ]
        where = ", ".join(
            f"{label} {format_ref(ref, include_title=False)}" for label, ref in units
        )
        doctor_head = self._doctor_head(ctx.project_dir)
        self._notifications.notify_stall(
            where or "no active unit",
            idle_minutes,
            doctor_head,
            target=self._target,
        )
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "mid": (p.active_milestone or {}).get("id"),
            "sid": (p.active_slice or {}).get("id"),
            "tid": (p.active_task or {}).get("id"),
            "idle_minutes": idle_minutes,
            "doctor_head": doctor_head,
        }
        try:
            log_path = Path(ctx.project_dir or ".") / ".gsd" / "stall-log.jsonl"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
        except OSError:
            pass

    def _doctor_head(self, project_dir: str | None) -> str:
        """First lines of `gsd doctor`; best-effort, never blocks the poll loop."""
        if not self._config.cli_path:
            return ""
        try:
            result = subprocess.run(
                [self._config.cli_path, "doctor"],
                cwd=project_dir,
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        lines = (result.stdout or result.stderr or "").strip().splitlines()
        return " / ".join(line.strip() for line in lines[:3] if line.strip())[:300]

    def _diff_progress(
        self, ctx: SupervisorContext, progress: ProgressSnapshot
    ) -> bool:
        prev = ctx.last_progress
        if prev is None:
            return False
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
        return bool(parts)
