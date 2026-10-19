"""Unit tests for MCP server process cwd selection."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from open_gsd_hermes.config import GsdConfig
from open_gsd_hermes.gsd_client import GsdMcpClient


def test_ensure_process_starts_server_in_project_cwd(tmp_path) -> None:
    client = GsdMcpClient(GsdConfig())
    fake_proc = MagicMock()
    fake_proc.poll.return_value = None

    with patch.object(client, "_initialize") as initialize:
        with patch("subprocess.Popen", return_value=fake_proc) as popen:
            proc = client._ensure_process(str(tmp_path))

    assert proc is fake_proc
    initialize.assert_called_once_with()
    assert popen.call_args.kwargs["cwd"] == str(tmp_path)
    assert popen.call_args.kwargs["env"]["GSD_MCP_CLIENT_MANAGED"] == "1"


def test_env_marks_mcp_sidecar_client_managed() -> None:
    client = GsdMcpClient(GsdConfig())
    assert client._env()["GSD_MCP_CLIENT_MANAGED"] == "1"
