"""Gateway notifications via ctx.dispatch_tool('send_message', ...)."""

from __future__ import annotations

import logging
from typing import Any, Callable

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.types import DeliveryTarget, PluginContext, SessionStatus

logger = logging.getLogger(__name__)


class NotificationService:
    """Format and send supervisor notifications to the gateway."""

    def __init__(
        self,
        ctx: PluginContext,
        config: GsdConfig,
        get_target: Callable[[], DeliveryTarget | None],
        dispatch: Callable[[str, dict[str, Any]], Any] | None = None,
    ) -> None:
        self._ctx = ctx
        self._config = config
        self._get_target = get_target
        self._dispatch = dispatch or ctx.dispatch_tool

    def resolve_target(self) -> DeliveryTarget | None:
        """Snapshot the live delivery target (call on a bound thread).

        Async senders (supervisor/milestone threads) run without a bound
        session key, so their target must be captured at thread spawn on
        the bound command thread and passed to send().
        """
        return self._get_target()

    def _should_send(self, kind: str) -> bool:
        level = self._config.notification_level
        if level == "verbose":
            return True
        if level == "quiet":
            return kind in ("blocker", "failure", "complete", "stall")
        # normal
        return kind in ("blocker", "transition", "failure", "complete", "stall")

    def send(
        self,
        text: str,
        *,
        kind: str = "transition",
        target: DeliveryTarget | None = None,
    ) -> bool:
        if not self._should_send(kind):
            return False
        # An explicit target (captured at thread spawn) wins; the live
        # resolution serves command-path callers and must not fall back to
        # env when a bound gateway target was captured.
        if target is None:
            target = self._get_target()
        if target is None:
            logger.warning(
                "GSD notification dropped (no delivery target): %s",
                text,
            )
            return False
        payload = {
            "platform": target.platform,
            "chat_type": target.chat_type,
            "chat_id": target.chat_id,
            "text": text,
        }
        try:
            self._dispatch("send_message", payload)
            return True
        except Exception:
            return False

    def notify_blocker(
        self, status: SessionStatus, target: DeliveryTarget | None = None
    ) -> None:
        blocker = status.pending_blocker or {}
        q = (
            blocker.get("question")
            or blocker.get("prompt")
            or blocker.get("title")
            or blocker.get("message")
            or "Action required"
        )
        self.send(
            f"🚧 GSD blocker: {q}\nReply with `/gsd reply <your answer>`",
            kind="blocker",
            target=target,
        )

    def notify_transition(
        self, message: str, target: DeliveryTarget | None = None
    ) -> None:
        self.send(f"📋 GSD: {message}", kind="transition", target=target)

    def notify_stall(
        self,
        where: str,
        idle_minutes: int,
        doctor_head: str = "",
        target: DeliveryTarget | None = None,
    ) -> None:
        msg = (
            f"⏳ GSD looks stalled: still running on {where} with no progress for "
            f"{idle_minutes} min."
        )
        if doctor_head:
            msg += f" gsd doctor: {doctor_head}"
        msg += " Check `/gsd status`; `/gsd cancel` to stop the session."
        self.send(msg, kind="stall", target=target)

    def notify_milestone_complete(
        self, message: str, target: DeliveryTarget | None = None
    ) -> None:
        self.send(message, kind="complete", target=target)

    def notify_terminal(
        self,
        status: str,
        error: str | None = None,
        target: DeliveryTarget | None = None,
    ) -> None:
        normalized_status = status.lower()
        if normalized_status in ("complete", "completed", "done"):
            self.send("✅ GSD auto mode finished.", kind="complete", target=target)
        elif normalized_status == "cancelled":
            self.send("⏹ GSD session cancelled.", kind="complete", target=target)
        else:
            msg = f"❌ GSD session {status}"
            if error:
                msg += f": {error}"
            self.send(msg, kind="failure", target=target)
