"""Tests for GsdMcpClient milestone creation (subprocess-owned, stream-driven).

These tests pin the A1 design from issue #1162's grilling:
- create_milestone spawns `gsd headless --supervised new-milestone`
- a background stream-reader drives NotificationService on blocker/terminal events
- cancel_milestone SIGTERMs the held subprocess
- respond_to_milestone_blocker writes an extension_ui_response to stdin
"""

from __future__ import annotations

from io import BytesIO
import json
import subprocess
from unittest.mock import MagicMock, patch

import pytest

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient
from open_gsd_hermes.types import DeliveryTarget, ProgressSnapshot


def _config() -> GsdConfig:
    return GsdConfig(cli_path="/usr/local/bin/gsd")


# ---------------------------------------------------------------------------
# create_milestone — argument construction
# ---------------------------------------------------------------------------


class _FakeProc:
    """Minimal stand-in for subprocess.Popen used by create_milestone."""

    def __init__(self) -> None:
        self.pid = 4242
        self.stdin = MagicMock()
        self.stdout = MagicMock()
        self.stderr = BytesIO()
        self.poll = MagicMock(return_value=None)
        self.terminate = MagicMock()
        self.wait = MagicMock(return_value=0)
        self.kill = MagicMock()


def test_create_milestone_builds_supervised_new_milestone_command_with_context_text() -> None:
    """create_milestone must invoke `gsd headless --supervised new-milestone --context-text <spec>`."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    captured: dict[str, object] = {}

    def fake_popen(args, **kwargs):  # type: ignore[no-untyped-def]
        captured["args"] = args
        captured["cwd"] = kwargs.get("cwd")
        captured["env"] = kwargs.get("env")
        return fake_proc

    with patch.object(client, "ensure_version"):
        with patch("subprocess.Popen", side_effect=fake_popen):
            with patch.object(client, "_milestone_stream_loop"):
                client.create_milestone("/proj", context_text="Build a REST API")

    args = captured["args"]
    assert args[0] == "/usr/local/bin/gsd"
    assert "headless" in args
    assert "--supervised" in args
    assert "--response-timeout" in args
    timeout_idx = args.index("--response-timeout")
    assert args[timeout_idx + 1] == str(GsdMcpClient._SUPERVISED_RESPONSE_TIMEOUT_MS)
    assert "new-milestone" in args
    assert "--context-text" in args
    text_idx = args.index("--context-text")
    assert args[text_idx + 1] == "Build a REST API"
    assert captured["cwd"] == "/proj"


def test_create_milestone_builds_command_with_context_file() -> None:
    """--file form passes --context <path> instead of --context-text."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()
    captured: dict[str, object] = {}

    def fake_popen(args, **kwargs):  # type: ignore[no-untyped-def]
        captured["args"] = args
        return fake_proc

    with patch.object(client, "ensure_version"):
        with patch("subprocess.Popen", side_effect=fake_popen):
            with patch.object(client, "_milestone_stream_loop"):
                client.create_milestone("/proj", context_file="/path/to/spec.md")

    args = captured["args"]
    assert "--context" in args
    ctx_idx = args.index("--context")
    assert args[ctx_idx + 1] == "/path/to/spec.md"
    assert "--context-text" not in args


def test_create_milestone_requires_either_context_text_or_file() -> None:
    """No spec at all is a usage error, raised before any subprocess spawns."""
    client = GsdMcpClient(_config())
    with pytest.raises(ValueError, match="spec"):
        client.create_milestone("/proj")


def test_create_milestone_rejects_both_context_text_and_file() -> None:
    """Ambiguous input (both forms) is a usage error."""
    client = GsdMcpClient(_config())
    with pytest.raises(ValueError, match="spec"):
        client.create_milestone(
            "/proj", context_text="x", context_file="/p.md"
        )


# ---------------------------------------------------------------------------
# Stream reader — sessionId capture, blocker, terminal
# ---------------------------------------------------------------------------


def test_create_milestone_returns_local_session_id_from_pid() -> None:
    """create_milestone returns a local session id without waiting for init_result."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    with patch.object(client, "ensure_version"):
        with patch("subprocess.Popen", return_value=fake_proc):
            with patch.object(client, "_milestone_stream_loop"):
                session_id = client.create_milestone("/proj", context_text="spec")

    assert session_id == "milestone-4242"


def test_stream_loop_captures_session_id_from_init_result() -> None:
    """The reader must pull sessionId out of the init_result stream event."""
    client = GsdMcpClient(_config())
    client._handle_milestone_event({"type": "init_result", "sessionId": "S-789"})

    assert client.milestone_session_id() == "S-789"


def test_stream_loop_notifies_blocker_on_supervised_select_request() -> None:
    """Supervised planning prompts (select/input/confirm) must fire notify_blocker."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    blocker_event = {
        "type": "extension_ui_request",
        "method": "select",
        "id": "sel-1",
        "title": "Choose milestone scope",
        "options": ["A", "B"],
    }
    with patch.object(client, "_milestone_notifications", notifications):
        client._handle_milestone_event(blocker_event)

    notifications.notify_blocker.assert_called_once()
    assert client.milestone_pending_blocker_id() == "sel-1"


def test_stream_loop_notifies_blocker_on_extension_ui_request() -> None:
    """Blocked-notice notify events are fire-and-forget; they must not prompt /gsd reply."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    # Realistic blocked-notice message — headless auto-acks notify in supervised mode.
    blocker_event = {
        "type": "extension_ui_request",
        "method": "notify",
        "id": "blk-1",
        "message": "Auto-mode paused — blocked: choose an option",
    }
    with patch.object(client, "_milestone_notifications", notifications):
        client._handle_milestone_event(blocker_event)

    notifications.notify_blocker.assert_not_called()
    assert client.milestone_pending_blocker_id() is None


def test_build_milestone_completion_message_uses_query_and_progress() -> None:
    client = GsdMcpClient(_config())
    with patch.object(
        client,
        "project_query",
        return_value={"milestones": [{"id": "M002", "hasRoadmap": True}]},
    ):
        with patch.object(
            client,
            "progress",
            return_value=ProgressSnapshot(
                active_milestone={"id": "M002"},
                slices={"total": 3},
                tasks={"total": 9},
            ),
        ):
            msg = client._build_milestone_completion_message("/proj")

    assert msg == "✅ Milestone M002 ready — 3 slices, 9 tasks. Run `/gsd auto` to start."


def test_build_milestone_completion_message_falls_back_when_query_empty() -> None:
    client = GsdMcpClient(_config())
    with patch.object(client, "project_query", return_value={"milestones": []}):
        msg = client._build_milestone_completion_message("/proj")

    assert msg == "✅ Milestone created. Run `/gsd status` for details."


def test_stream_loop_notifies_terminal_on_process_exit() -> None:
    """When the stream ends (process exited), a milestone completion notification fires."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    fake_proc = _FakeProc()
    fake_proc.poll.return_value = 0
    fake_proc.stdout.readline.side_effect = [b""]
    client._milestone_session_id = "milestone-4242"
    client._milestone_pending_blocker_id = "old-blocker"
    client._milestone_pending_blocker_method = "input"

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_project_dir", "/proj"):
            with patch.object(
                client,
                "_build_milestone_completion_message",
                return_value="✅ Milestone M001 ready — 2 slices, 5 tasks. Run `/gsd auto` to start.",
            ):
                with patch.object(client, "_milestone_notifications", notifications):
                    client._milestone_stream_loop(fake_proc)

    notifications.notify_milestone_complete.assert_called_once_with(
        "✅ Milestone M001 ready — 2 slices, 5 tasks. Run `/gsd auto` to start.",
        target=None,
    )
    notifications.notify_terminal.assert_not_called()
    assert client.milestone_active() is False
    assert client.milestone_session_id() is None
    assert client.milestone_pending_blocker_id() is None
    assert client._milestone_pending_blocker_method is None


def test_milestone_reader_forwards_target_captured_at_spawn() -> None:
    """The reader passes the command-thread target snapshot to its notifies.

    The reader thread has no session binding, so create_milestone's caller
    captures the delivery target on the bound command thread and the
    snapshot is forwarded verbatim (issue #2288).
    """
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    target = DeliveryTarget("slack", "channel", "C_A")
    fake_proc = _FakeProc()
    fake_proc.poll.return_value = 0
    fake_proc.stdout.readline.side_effect = [b""]

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_project_dir", "/proj"):
            with patch.object(client, "_milestone_notifications", notifications):
                with patch.object(client, "_milestone_notify_target", target):
                    client._milestone_stream_loop(fake_proc)

    call = notifications.notify_milestone_complete.call_args
    assert call.kwargs["target"] is target


def test_stream_loop_failure_reports_drained_stderr() -> None:
    """Failure notifications must use stderr retained by the drain thread."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    fake_proc = _FakeProc()
    fake_proc.poll.return_value = 2
    fake_proc.stderr = BytesIO(b"fatal diagnostics\n")
    fake_proc.stdout.readline.side_effect = [b""]

    client._drain_milestone_stderr(fake_proc)
    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_notifications", notifications):
            client._milestone_stream_loop(fake_proc)

    notifications.notify_terminal.assert_called_once_with(
        "failed", "fatal diagnostics", target=None
    )


def test_stream_loop_releases_blocked_exit_with_pending_blocker() -> None:
    """Exit 10 after stdout EOF is terminal even with a pending blocker id."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    fake_proc = _FakeProc()
    fake_proc.poll.return_value = 10
    fake_proc.stdout.readline.side_effect = [b""]
    client._milestone_session_id = "milestone-4242"

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_pending_blocker_id", "sel-1"):
            with patch.object(client, "_milestone_notifications", notifications):
                client._milestone_stream_loop(fake_proc)

    notifications.notify_terminal.assert_called_once_with(
        "failed", "Planning blocked", target=None
    )
    assert client.milestone_active() is False
    assert client.milestone_session_id() is None


def test_stream_loop_releases_noninteractive_blocked_exit() -> None:
    """Exit 10 without a pending blocker must not leave milestone ownership stuck."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    fake_proc = _FakeProc()
    fake_proc.poll.return_value = 10
    fake_proc.stdout.readline.side_effect = [b""]
    client._milestone_session_id = "milestone-4242"

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_notifications", notifications):
            client._milestone_stream_loop(fake_proc)

    notifications.notify_terminal.assert_called_once_with(
        "failed", "Planning blocked", target=None
    )
    assert client.milestone_active() is False
    assert client.milestone_session_id() is None


def test_stream_loop_retains_running_proc_on_stream_loss() -> None:
    """If stdout closes while the child is alive, /gsd cancel must still work."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    on_terminal = MagicMock()
    fake_proc = _FakeProc()
    fake_proc.poll.return_value = None
    fake_proc.wait.side_effect = subprocess.TimeoutExpired(cmd="gsd", timeout=5)
    fake_proc.stdout.readline.side_effect = [b""]
    client._milestone_session_id = "milestone-4242"

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_notifications", notifications):
            with patch.object(client, "_milestone_on_terminal", on_terminal):
                client._milestone_stream_loop(fake_proc)

                notifications.notify_terminal.assert_called_once_with(
                    "failed", "stream lost — run /gsd cancel", target=None
                )
                on_terminal.assert_called_once_with("failed")
                assert client.milestone_active() is True
                assert client.milestone_session_id() == "milestone-4242"

                client.cancel_milestone()

    fake_proc.terminate.assert_called_once()
    assert client.milestone_active() is False


def test_stream_loop_handles_blocking_command_block() -> None:
    """gsd-command-block failures must not be reported as milestone complete."""
    client = GsdMcpClient(_config())
    notifications = MagicMock()
    fake_proc = _FakeProc()
    client._milestone_session_id = "milestone-4242"
    command_block = {
        "type": "message_start",
        "message": {
            "role": "custom",
            "customType": "gsd-command-block",
            "content": (
                "/gsd auto cannot run because the active milestone "
                "is blocked by validation."
            ),
        },
    }
    fake_proc.poll.return_value = 0
    fake_proc.stdout.readline.side_effect = [
        (json.dumps(command_block) + "\n").encode(),
        b"",
    ]

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_notifications", notifications):
            client._milestone_stream_loop(fake_proc)

    notifications.notify_terminal.assert_called_with(
        "failed",
        "/gsd auto cannot run because the active milestone is blocked by validation.",
        target=None,
    )
    notifications.notify_milestone_complete.assert_not_called()
    assert client.milestone_active() is False
    assert client.milestone_session_id() is None


# ---------------------------------------------------------------------------
# cancel_milestone / respond_to_milestone_blocker / milestone_active
# ---------------------------------------------------------------------------


def test_cancel_milestone_terminates_held_subprocess() -> None:
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    with patch.object(client, "_milestone_proc", fake_proc):
        client.cancel_milestone()

    fake_proc.terminate.assert_called_once()


def test_cancel_milestone_when_no_proc_is_a_noop() -> None:
    """Calling cancel with no active milestone proc must not raise."""
    client = GsdMcpClient(_config())
    # should not raise
    client.cancel_milestone()


def test_close_terminates_active_milestone_subprocess() -> None:
    """close() must tear down the owned milestone subprocess as well as MCP."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    with (
        patch.object(client, "_terminate_process"),
        patch.object(client, "_milestone_proc", fake_proc),
    ):
        client.close()

    fake_proc.terminate.assert_called_once()
    assert client.milestone_active() is False


def test_respond_to_milestone_blocker_writes_extension_ui_response_to_stdin() -> None:
    """The reply must write the supervised-mode stdin JSONL protocol."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_pending_blocker_id", "blk-7"):
            with patch.object(client, "_milestone_pending_blocker_method", "input"):
                client.respond_to_milestone_blocker("use option B")

    assert fake_proc.stdin.write.called
    written = fake_proc.stdin.write.call_args[0][0]
    payload = json.loads(written.decode() if isinstance(written, bytes) else written)
    assert payload["type"] == "extension_ui_response"
    assert payload["id"] == "blk-7"
    assert payload["value"] == "use option B"


def test_respond_to_milestone_blocker_writes_confirmed_for_confirm_prompt() -> None:
    """Confirm blockers must answer with a confirmed boolean, not free text."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()

    with patch.object(client, "_milestone_proc", fake_proc):
        with patch.object(client, "_milestone_pending_blocker_id", "cfm-1"):
            with patch.object(client, "_milestone_pending_blocker_method", "confirm"):
                client.respond_to_milestone_blocker("yes")

    written = fake_proc.stdin.write.call_args[0][0]
    payload = json.loads(written.decode() if isinstance(written, bytes) else written)
    assert payload["type"] == "extension_ui_response"
    assert payload["id"] == "cfm-1"
    assert payload["confirmed"] is True
    assert "value" not in payload


def test_respond_to_milestone_blocker_without_pending_blocker_raises() -> None:
    """No pending blocker id means nothing to reply to — fail loud, don't pretend."""
    client = GsdMcpClient(_config())
    fake_proc = _FakeProc()
    with patch.object(client, "_milestone_proc", fake_proc):
        with pytest.raises(RuntimeError, match="No pending blocker"):
            client.respond_to_milestone_blocker("answer")


def test_milestone_active_reflects_held_proc() -> None:
    client = GsdMcpClient(_config())
    assert client.milestone_active() is False
    with patch.object(client, "_milestone_proc", _FakeProc()):
        assert client.milestone_active() is True
    assert client.milestone_active() is False
