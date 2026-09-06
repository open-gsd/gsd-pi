"""Persistent gsd-mcp-server MCP client (stdio JSON-RPC)."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from packaging import version

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.types import ProgressSnapshot, SessionStatus


class GsdVersionError(Exception):
    pass


class McpProtocolError(Exception):
    pass


@dataclass
class _CacheEntry:
    value: Any
    expires_at: float


class GsdMcpClient:
    """JSON-RPC client for gsd-mcp-server with TTL cache for read tools."""

    def __init__(self, config: GsdConfig) -> None:
        self._config = config
        self._proc: subprocess.Popen[bytes] | None = None
        self._proc_cwd: str | None = None
        self._stdout_buffer = b""
        self._lock = threading.Lock()
        self._request_id = 0
        self._cache: dict[str, _CacheEntry] = {}
        self._version_checked = False
        # Milestone subprocess state (issue #1162). The plugin owns the
        # `gsd headless --supervised new-milestone` process directly, so the
        # MCP session manager cannot see or reach it. This client is the sole
        # owner of its lifecycle (cancel, blocker replies, terminal events).
        self._milestone_proc: subprocess.Popen[bytes] | None = None
        self._milestone_session_id: str | None = None
        self._milestone_pending_blocker_id: str | None = None
        self._milestone_pending_blocker_method: str | None = None
        self._milestone_command_block_failure: str | None = None
        self._milestone_notifications: Any = None  # NotificationService | None
        self._milestone_project_dir: str | None = None
        self._milestone_on_terminal: Callable[[str], None] | None = None
        self._milestone_notified_terminal: bool = False
        self._milestone_thread: threading.Thread | None = None
        self._milestone_stderr_thread: threading.Thread | None = None
        self._milestone_stderr_lock = threading.Lock()
        self._milestone_stderr_tail = bytearray()

    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        # Resolve cli_path to an absolute path so the MCP server's
        # resolveCLIPath() does not resolve a bare command name (e.g. "gsd")
        # against the project directory, producing a non-existent
        # project-relative path that hangs gsd_execute until timeout.
        resolved = shutil.which(self._config.cli_path) or self._config.cli_path
        env["GSD_CLI_PATH"] = resolved
        return env

    def ensure_version(self) -> None:
        if self._version_checked:
            return
        result = subprocess.run(
            [self._config.cli_path, "--version"],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        out = (result.stdout or result.stderr or "").strip()
        # gsd --version may print "1.0.2" or "gsd 1.0.2"
        ver_str = out.split()[-1] if out else "0"
        try:
            ver = version.parse(ver_str)
        except version.InvalidVersion as e:
            raise GsdVersionError(f"Could not parse gsd version from: {out!r}") from e
        min_v = version.parse(self._config.gsd_version_min)
        max_v = version.parse(self._config.gsd_version_max)
        if ver < min_v or ver >= max_v:
            raise GsdVersionError(
                f"gsd {ver} not in supported range "
                f">={self._config.gsd_version_min},<{self._config.gsd_version_max}"
            )
        self._version_checked = True

    def _ensure_process(self, project_dir: str | None = None) -> subprocess.Popen[bytes]:
        cwd = (
            os.path.abspath(project_dir)
            if project_dir is not None
            else self._proc_cwd
        )
        if self._proc is not None and self._proc.poll() is None:
            if cwd is None or self._proc_cwd == cwd:
                return self._proc
            self._terminate_process()
        self._stdout_buffer = b""
        self._proc_cwd = cwd
        self._proc = subprocess.Popen(
            [self._config.mcp_server_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self._env(),
            cwd=cwd,
        )
        try:
            self._initialize()
        except Exception:
            self._terminate_process()
            raise
        return self._proc

    def _terminate_process(self) -> None:
        proc = self._proc
        self._proc = None
        self._proc_cwd = None
        self._stdout_buffer = b""
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    def _send(self, payload: dict[str, Any], *, project_dir: str | None = None) -> None:
        proc = self._ensure_process(project_dir)
        assert proc.stdin is not None
        # gsd-mcp-server uses the @modelcontextprotocol/sdk stdio transport,
        # which is newline-delimited JSON (NDJSON), not the Content-Length
        # framing from the LSP-style MCP spec. Emit one JSON object per line.
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
        proc.stdin.write(data)
        proc.stdin.flush()

    def _read_stdout_chunk(self, deadline: float) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            self._terminate_process()
            raise McpProtocolError("MCP server closed stdout")
        assert proc.stdout is not None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            self._raise_read_timeout()

        chunks: list[bytes] = []
        errors: list[BaseException] = []

        def read_chunk() -> None:
            try:
                chunks.append(os.read(proc.stdout.fileno(), 65536))
            except BaseException as e:
                errors.append(e)

        reader = threading.Thread(target=read_chunk, daemon=True)
        reader.start()
        reader.join(remaining)
        if reader.is_alive():
            self._raise_read_timeout()
        if errors:
            self._terminate_process()
            raise McpProtocolError(f"MCP server stdout read failed: {errors[0]}")
        chunk = chunks[0] if chunks else b""
        if not chunk:
            self._terminate_process()
            raise McpProtocolError("MCP server closed stdout")
        self._stdout_buffer += chunk

    def _raise_read_timeout(self) -> None:
        self._terminate_process()
        raise McpProtocolError(
            f"MCP server response timed out after "
            f"{self._config.mcp_read_timeout_seconds:g}s"
        )

    def _read_line(self, deadline: float) -> bytes:
        while True:
            idx = self._stdout_buffer.find(b"\n")
            if idx >= 0:
                raw = self._stdout_buffer[:idx]
                self._stdout_buffer = self._stdout_buffer[idx + 1 :]
                return raw.rstrip(b"\r")
            self._read_stdout_chunk(deadline)

    def _read_message(self) -> dict[str, Any]:
        deadline = time.monotonic() + self._config.mcp_read_timeout_seconds
        # gsd-mcp-server emits newline-delimited JSON (NDJSON); each line is a
        # complete JSON-RPC message. Skip blank keep-alive lines.
        while True:
            line = self._read_line(deadline)
            if line.strip():
                return json.loads(line.decode("utf-8"))

    def _initialize(self) -> None:
        self._request_id += 1
        self._send(
            {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "open-gsd-hermes", "version": "1.18.0"},
                },
            }
        )
        _ = self._read_message()
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _call_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        check_version: bool = True,
        project_dir: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if check_version:
                self.ensure_version()
            self._request_id += 1
            req_id = self._request_id
            self._send(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                },
                project_dir=project_dir,
            )
            while True:
                msg = self._read_message()
                if msg.get("id") == req_id:
                    if "error" in msg:
                        raise McpProtocolError(str(msg["error"]))
                    result = msg.get("result") or {}
                    content = result.get("content") or []
                    if not content:
                        return {}
                    text = content[0].get("text", "{}")
                    if result.get("isError"):
                        raise McpProtocolError(text)
                    return json.loads(text) if isinstance(text, str) else text

    def _cached(self, key: str, fetch: Any) -> Any:
        now = time.monotonic()
        entry = self._cache.get(key)
        if entry and entry.expires_at > now:
            return entry.value
        value = fetch()
        self._cache[key] = _CacheEntry(
            value=value,
            expires_at=now + self._config.cache_ttl_seconds,
        )
        return value

    def invalidate_cache(self, project_dir: str | None = None) -> None:
        if project_dir is None:
            self._cache.clear()
            return
        self._cache.pop(f"progress:{project_dir}", None)

    def _read_progress_cli(self, project_dir: str) -> ProgressSnapshot:
        """Read progress via `gsd read progress --json` (6c hot path)."""
        result = subprocess.run(
            [
                self._config.cli_path,
                "read",
                "progress",
                "--json",
                "--project",
                project_dir,
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
            env=self._env(),
        )
        if result.returncode != 0:
            raise McpProtocolError(
                (result.stderr or result.stdout or "gsd read progress failed").strip()
            )
        envelope = json.loads(result.stdout)
        data = envelope.get("data") or {}
        return ProgressSnapshot.from_mcp(data)

    def progress(self, project_dir: str) -> ProgressSnapshot:
        def fetch() -> ProgressSnapshot:
            try:
                self.ensure_version()
                return self._read_progress_cli(project_dir)
            except (
                GsdVersionError,
                McpProtocolError,
                json.JSONDecodeError,
                AttributeError,
                TypeError,
                KeyError,
                OSError,
                subprocess.TimeoutExpired,
            ):
                data = self._call_tool(
                    "gsd_progress",
                    {"projectDir": project_dir},
                    check_version=False,
                    project_dir=project_dir,
                )
                return ProgressSnapshot.from_mcp(data)

        key = f"progress:{project_dir}"
        return self._cached(key, fetch)

    def status(self, session_id: str) -> SessionStatus:
        data = self._call_tool("gsd_status", {"sessionId": session_id})
        return SessionStatus.from_mcp(data)

    def execute(self, project_dir: str, *, command: str = "/gsd auto") -> dict[str, Any]:
        self.invalidate_cache(project_dir)
        args = {"projectDir": project_dir, "command": command}
        try:
            return self._call_tool("gsd_execute", args, project_dir=project_dir)
        except GsdVersionError:
            return self._call_tool(
                "gsd_execute",
                args,
                check_version=False,
                project_dir=project_dir,
            )

    def cancel(
        self,
        *,
        session_id: str | None = None,
        project_dir: str | None = None,
    ) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if session_id:
            args["sessionId"] = session_id
        if project_dir:
            args["projectDir"] = project_dir
        return self._call_tool("gsd_cancel", args, project_dir=project_dir)

    def cancel_by_project(self, project_dir: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_cancel_by_project",
            {"projectDir": project_dir},
            project_dir=project_dir,
        )

    def resolve_blocker(self, session_id: str, response: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_resolve_blocker",
            {"sessionId": session_id, "response": response},
        )

    def memory_query(self, project_dir: str, query: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_memory_query",
            {"projectDir": project_dir, "query": query},
            project_dir=project_dir,
        )

    def project_query(self, project_dir: str, query: str) -> dict[str, Any]:
        return self._call_tool(
            "gsd_query",
            {"projectDir": project_dir, "query": query},
        )

    # ------------------------------------------------------------------
    # Milestone creation (issue #1162)
    #
    # The plugin spawns `gsd headless --supervised new-milestone` directly
    # and owns the subprocess. The MCP session manager cannot see it (it
    # only knows sessions it started via gsd_execute), and there is no
    # auto.lock pid backstop during the planning phase. So this client is
    # the sole owner of the subprocess's lifecycle: cancel (SIGTERM),
    # blocker replies (stdin), and transition/terminal notifications
    # (stdout stream). See integrations/hermes/docs/issue-1162-grilling.md.
    # ------------------------------------------------------------------

    # Stop-notice vocabulary mirrored from src/resources/extensions/gsd/stop-notice.ts.
    # Keep both sides in lockstep; the canonical prefixes the headless event
    # loop emits in notify messages. Terminal detection is handled by process
    # exit (the stream reader emits notify_terminal on stdout EOF), so only the
    # blocked-notice classifier is needed here.
    _PAUSED_NOTICE_PREFIXES = ("auto-mode paused", "step-mode paused")
    _FIRE_AND_FORGET_UI_METHODS = frozenset(
        {"notify", "setStatus", "setWidget", "setTitle", "set_editor_text"}
    )
    _EXIT_BLOCKED = 10
    _STDERR_TAIL_LIMIT = 64 * 1024
    # Supervised headless defaults to 30s; chat /gsd reply needs much longer.
    _SUPERVISED_RESPONSE_TIMEOUT_MS = 3_600_000

    def _is_blocked_notice(self, message: str) -> bool:
        """Mirror of stop-notice.ts isBlockedNoticeMessage (lowercased input)."""
        if "blocked:" in message:
            return True
        if any(message.startswith(p) for p in self._PAUSED_NOTICE_PREFIXES):
            if "idempotent advance: unit already active" not in message:
                return True
        return (
            "resolve manually and re-run /gsd auto" in message
            or "resolve conflicts manually and run /gsd auto to resume" in message
            or "resolve and run /gsd auto to resume" in message
        )

    def _is_milestone_blocker_event(self, event: dict[str, Any]) -> bool:
        """True for supervised interactive UI requests (select/input/confirm/editor)."""
        method = str(event.get("method") or "")
        if method in self._FIRE_AND_FORGET_UI_METHODS:
            return False
        return True

    def _get_command_block_content(self, event: dict[str, Any]) -> str | None:
        """Extract gsd-command-block message content from stream events."""
        etype = event.get("type")
        if etype not in ("message_start", "message_end"):
            return None
        message = event.get("message")
        if not isinstance(message, dict):
            return None
        if message.get("customType") != "gsd-command-block":
            return None
        return str(message.get("content") or "")

    def _is_blocking_command_block(self, event: dict[str, Any]) -> bool:
        """Mirror headless-events isBlockingCommandBlock."""
        content = self._get_command_block_content(event)
        if not content:
            return False
        lowered = content.lower()
        return (
            (
                "cannot start new workflow work" in lowered
                and "complete but not merged" in lowered
            )
            or "cannot run because the active milestone is blocked by validation"
            in lowered
        )

    def _parse_confirm_response(self, response: str) -> bool:
        normalized = response.strip().lower()
        if normalized in ("no", "n", "false", "0", "cancel", "decline"):
            return False
        return True

    def create_milestone(
        self,
        project_dir: str,
        *,
        context_text: str | None = None,
        context_file: str | None = None,
        notifications: Any = None,
        on_terminal: Callable[[str], None] | None = None,
    ) -> str:
        """Spawn `gsd headless --supervised new-milestone` and return a session id.

        The subprocess is started detached; a background thread reads its
        stream-json stdout and drives the supplied NotificationService on
        blocker/terminal events. Returns a local session id immediately
        (headless does not emit init_result on stdout).

        Raises ValueError if neither (or both) of context_text/context_file
        is supplied.
        """
        if bool(context_text) == bool(context_file):
            raise ValueError(
                "Provide exactly one milestone spec: context_text or context_file"
            )
        self.ensure_version()
        if self._milestone_proc is not None and self._milestone_proc.poll() is None:
            raise RuntimeError("Milestone creation already in progress.")

        args: list[str] = [
            self._config.cli_path,
            "headless",
            "--supervised",
            "--response-timeout",
            str(self._SUPERVISED_RESPONSE_TIMEOUT_MS),
            "--output-format",
            "stream-json",
        ]
        if context_text:
            args += ["--context-text", context_text]
        else:
            assert context_file is not None
            args += ["--context", context_file]
        args.append("new-milestone")

        proc = subprocess.Popen(  # noqa: S603 - args list, not shell
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=project_dir,
            env=self._env(),
        )
        self._milestone_proc = proc
        self._milestone_session_id = None
        self._milestone_pending_blocker_id = None
        self._milestone_pending_blocker_method = None
        self._milestone_command_block_failure = None
        self._milestone_notifications = notifications
        self._milestone_project_dir = project_dir
        self._milestone_on_terminal = on_terminal
        self._milestone_notified_terminal = False
        self._clear_milestone_stderr()
        self._milestone_stderr_thread = threading.Thread(
            target=self._drain_milestone_stderr,
            args=(proc,),
            daemon=True,
        )
        self._milestone_stderr_thread.start()

        # Headless stream-json does not emit init_result on stdout (init is an
        # internal RPC handshake). Use a local session id for ack/status only;
        # milestone lifecycle is keyed on the held subprocess, not MCP.
        session_id = f"milestone-{proc.pid}"
        self._milestone_session_id = session_id

        self._milestone_thread = threading.Thread(
            target=self._milestone_stream_loop,
            args=(proc,),
            daemon=True,
        )
        self._milestone_thread.start()
        return session_id

    def _milestone_stream_loop(self, proc: subprocess.Popen[bytes]) -> None:
        """Background reader: capture blocker/terminal events and notify.

        Best-effort. On stream loss we surface FAILED via notify_terminal so
        the user can `/gsd cancel` to clean up (no watchdog; the cancel
        escape hatch is the safety net).
        """
        assert proc.stdout is not None
        try:
            while True:
                line = proc.stdout.readline()
                if not line:
                    break
                try:
                    event = json.loads(line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if self._milestone_proc is not proc:
                    return
                self._handle_milestone_event(event)
        except Exception:
            pass
        if self._milestone_proc is not proc:
            return
        if self._milestone_notified_terminal:
            if proc.poll() is not None:
                self._clear_milestone_state()
            return
        exit_code = proc.poll()
        if exit_code is None:
            try:
                exit_code = proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                exit_code = None
        if exit_code == self._EXIT_BLOCKED:
            if not self._milestone_notified_terminal:
                if self._milestone_notifications is not None:
                    self._milestone_notifications.notify_terminal(
                        "failed", "Planning blocked"
                    )
                if self._milestone_on_terminal is not None:
                    self._milestone_on_terminal("failed")
                self._milestone_notified_terminal = True
            self._clear_milestone_state()
            return
        if exit_code == 0:
            if self._milestone_command_block_failure:
                status = "failed"
                error = self._milestone_command_block_failure
            else:
                status = "complete"
                error = None
        elif exit_code is not None:
            status = "failed"
            self._join_milestone_stderr_thread()
            error = self._milestone_stderr_text(proc) or f"exit code {exit_code}"
        else:
            status = "failed"
            error = "stream lost — run /gsd cancel"
        if self._milestone_notifications is not None:
            if status == "complete":
                summary = self._build_milestone_completion_message(
                    self._milestone_project_dir or ""
                )
                self._milestone_notifications.notify_milestone_complete(summary)
            else:
                self._milestone_notifications.notify_terminal(status, error)
        if self._milestone_on_terminal is not None:
            self._milestone_on_terminal(status)
        self._milestone_notified_terminal = True
        if exit_code is not None:
            self._clear_milestone_state()
        else:
            self._milestone_pending_blocker_id = None
            self._milestone_pending_blocker_method = None

    def _drain_milestone_stderr(self, proc: subprocess.Popen[bytes]) -> None:
        """Drain stderr so a full pipe cannot stall the child process."""
        if proc.stderr is None:
            return
        try:
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                self._append_milestone_stderr(chunk)
        except Exception:
            pass

    def _append_milestone_stderr(self, chunk: bytes) -> None:
        with self._milestone_stderr_lock:
            self._milestone_stderr_tail.extend(chunk)
            overflow = len(self._milestone_stderr_tail) - self._STDERR_TAIL_LIMIT
            if overflow > 0:
                del self._milestone_stderr_tail[:overflow]

    def _clear_milestone_stderr(self) -> None:
        with self._milestone_stderr_lock:
            self._milestone_stderr_tail.clear()

    def _join_milestone_stderr_thread(self) -> None:
        thread = self._milestone_stderr_thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=1)

    def _milestone_stderr_text(self, proc: subprocess.Popen[bytes]) -> str:
        with self._milestone_stderr_lock:
            err_bytes = bytes(self._milestone_stderr_tail)
        if not err_bytes and proc.stderr is not None:
            try:
                err_bytes = proc.stderr.read()
            except Exception:
                err_bytes = b""
        return err_bytes.decode("utf-8", errors="replace").strip()

    def _handle_milestone_event(self, event: dict[str, Any]) -> None:
        etype = event.get("type")
        if etype == "init_result":
            sid = event.get("sessionId")
            if sid:
                self._milestone_session_id = str(sid)
            return
        if self._is_blocking_command_block(event):
            failure = self._get_command_block_content(event) or "Planning blocked"
            self._milestone_command_block_failure = failure
            if not self._milestone_notified_terminal:
                if self._milestone_notifications is not None:
                    self._milestone_notifications.notify_terminal("failed", failure)
                if self._milestone_on_terminal is not None:
                    self._milestone_on_terminal("failed")
                self._milestone_notified_terminal = True
            return
        if etype != "extension_ui_request":
            return
        if not self._is_milestone_blocker_event(event):
            return
        event_id = str(event.get("id") or "")
        self._milestone_pending_blocker_id = event_id or None
        self._milestone_pending_blocker_method = str(event.get("method") or "") or None
        if self._milestone_notifications is not None:
            self._milestone_notifications.notify_blocker(
                SessionStatus(
                    status="blocked",
                    pending_blocker=event,
                    session_id=self._milestone_session_id,
                )
            )

    def cancel_milestone(self) -> None:
        """SIGTERM the held milestone subprocess and clear state."""
        proc = self._milestone_proc
        if proc is None:
            return
        self._milestone_notified_terminal = True
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except Exception:
                pass
        if self._milestone_proc is proc:
            self._clear_milestone_state()

    def _release_milestone_proc(self) -> None:
        self._milestone_proc = None
        self._milestone_notifications = None
        self._milestone_on_terminal = None
        self._milestone_stderr_thread = None
        self._clear_milestone_stderr()

    def _build_milestone_completion_message(self, project_dir: str) -> str:
        fallback = "✅ Milestone created. Run `/gsd status` for details."
        if not project_dir:
            return fallback
        try:
            query_data = self.project_query(project_dir, "milestones")
        except Exception:
            return fallback
        milestones = query_data.get("milestones")
        if not milestones:
            return fallback
        try:
            self.invalidate_cache(project_dir)
            snap = self.progress(project_dir)
        except Exception:
            snap = None
        milestone_id: str | None = None
        if snap and snap.active_milestone:
            milestone_id = snap.active_milestone.get("id")
        if not milestone_id:
            last = milestones[-1]
            if isinstance(last, dict):
                milestone_id = last.get("id")
        if not milestone_id:
            return fallback
        slice_total = snap.slices.get("total", 0) if snap else 0
        task_total = snap.tasks.get("total", 0) if snap else 0
        msg = f"✅ Milestone {milestone_id} ready"
        counts: list[str] = []
        if slice_total:
            counts.append(f"{slice_total} slice{'s' if slice_total != 1 else ''}")
        if task_total:
            counts.append(f"{task_total} task{'s' if task_total != 1 else ''}")
        if counts:
            msg += f" — {', '.join(counts)}"
        return f"{msg}. Run `/gsd auto` to start."

    def _clear_milestone_state(self) -> None:
        self._release_milestone_proc()
        self._milestone_session_id = None
        self._milestone_project_dir = None
        self._milestone_pending_blocker_id = None
        self._milestone_pending_blocker_method = None
        self._milestone_command_block_failure = None

    def respond_to_milestone_blocker(self, response: str) -> None:
        """Write an extension_ui_response to the milestone subprocess stdin.

        Uses the supervised-mode JSONL protocol (see startSupervisedStdinReader
        in src/headless-ui.ts): {"type":"extension_ui_response","id":...,"value":...}
        or {"type":"extension_ui_response","id":...,"confirmed":...} for confirm prompts.
        """
        proc = self._milestone_proc
        blocker_id = self._milestone_pending_blocker_id
        if self._milestone_notified_terminal:
            raise RuntimeError(
                "Milestone session is no longer accepting replies. "
                "Run `/gsd cancel` to clean up."
            )
        if proc is None or not blocker_id:
            raise RuntimeError(
                "No pending blocker for the active milestone session."
            )
        assert proc.stdin is not None
        response_payload: dict[str, Any] = {
            "type": "extension_ui_response",
            "id": blocker_id,
        }
        if self._milestone_pending_blocker_method == "confirm":
            response_payload["confirmed"] = self._parse_confirm_response(response)
        else:
            response_payload["value"] = response
        payload = json.dumps(response_payload).encode("utf-8")
        proc.stdin.write(payload + b"\n")
        proc.stdin.flush()
        self._milestone_pending_blocker_id = None
        self._milestone_pending_blocker_method = None

    def milestone_active(self) -> bool:
        proc = self._milestone_proc
        if proc is None:
            return False
        thread = self._milestone_thread
        if thread is not None and thread.is_alive():
            return True
        if proc.poll() is None:
            return True
        self._clear_milestone_state()
        return False

    def milestone_session_id(self) -> str | None:
        return self._milestone_session_id

    def milestone_pending_blocker_id(self) -> str | None:
        return self._milestone_pending_blocker_id

    def close(self) -> None:
        self._terminate_process()
        if self._milestone_proc is not None:
            self.cancel_milestone()
