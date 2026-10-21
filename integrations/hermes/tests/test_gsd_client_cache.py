"""Unit tests for MCP client TTL cache (no subprocess)."""

from __future__ import annotations

import json
import subprocess
import time
from unittest.mock import patch

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient, GsdVersionError
from open_gsd_hermes.types import ProgressSnapshot


def test_progress_cache_ttl() -> None:
    config = GsdConfig(cache_ttl_seconds=1)
    client = GsdMcpClient(config)
    calls = {"n": 0}

    def fake_read(project_dir: str) -> ProgressSnapshot:
        calls["n"] += 1
        return ProgressSnapshot(phase="execute", blockers=[], next_action="")

    with patch.object(client, "_read_progress_cli", side_effect=fake_read):
        with patch.object(client, "ensure_version"):
            client.progress("/tmp/p")
            client.progress("/tmp/p")
            assert calls["n"] == 1
            time.sleep(1.1)
            client.progress("/tmp/p")
            assert calls["n"] == 2


def test_invalidate_cache_only_removes_exact_project() -> None:
    client = GsdMcpClient(GsdConfig(cache_ttl_seconds=60))
    calls: dict[str, int] = {}

    def fake_read(project_dir: str) -> ProgressSnapshot:
        calls[project_dir] = calls.get(project_dir, 0) + 1
        return ProgressSnapshot(phase="execute", blockers=[], next_action=project_dir)

    with patch.object(client, "_read_progress_cli", side_effect=fake_read):
        with patch.object(client, "ensure_version"):
            client.progress("/tmp/app")
            client.progress("/tmp/app-v2")

            client.invalidate_cache("/tmp/app")

            client.progress("/tmp/app-v2")
            client.progress("/tmp/app")

    assert calls["/tmp/app-v2"] == 1
    assert calls["/tmp/app"] == 2


def test_progress_falls_back_to_mcp_when_cli_binary_is_missing() -> None:
    client = GsdMcpClient(GsdConfig())

    with patch.object(client, "ensure_version", side_effect=FileNotFoundError("gsd")):
        with patch.object(
            client,
            "_call_tool",
            return_value={"phase": "execute", "nextAction": "from mcp"},
        ) as call_tool:
            progress = client.progress("/tmp/p")

    assert progress.phase == "execute"
    assert progress.next_action == "from mcp"
    call_tool.assert_called_once_with(
        "gsd_progress",
        {"projectDir": "/tmp/p"},
        check_version=False,
        project_dir="/tmp/p",
    )


def test_progress_falls_back_to_mcp_when_cli_version_is_unsupported() -> None:
    client = GsdMcpClient(GsdConfig())

    with patch.object(client, "ensure_version", side_effect=GsdVersionError("old gsd")):
        with patch.object(
            client,
            "_call_tool",
            return_value={"phase": "execute", "nextAction": "from mcp"},
        ) as call_tool:
            progress = client.progress("/tmp/p")

    assert progress.phase == "execute"
    assert progress.next_action == "from mcp"
    call_tool.assert_called_once_with(
        "gsd_progress",
        {"projectDir": "/tmp/p"},
        check_version=False,
        project_dir="/tmp/p",
    )


def test_progress_falls_back_to_mcp_when_cli_json_has_unexpected_shape() -> None:
    client = GsdMcpClient(GsdConfig())
    cli_result = subprocess.CompletedProcess(
        args=["gsd", "read", "progress"],
        returncode=0,
        stdout=json.dumps(["unexpected"]),
        stderr="",
    )

    with patch.object(client, "ensure_version"):
        with patch("subprocess.run", return_value=cli_result):
            with patch.object(
                client,
                "_call_tool",
                return_value={"phase": "execute", "nextAction": "from mcp"},
            ) as call_tool:
                progress = client.progress("/tmp/p")

    assert progress.phase == "execute"
    assert progress.next_action == "from mcp"
    call_tool.assert_called_once_with(
        "gsd_progress",
        {"projectDir": "/tmp/p"},
        check_version=False,
        project_dir="/tmp/p",
    )
