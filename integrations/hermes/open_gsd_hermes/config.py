"""Load ~/.hermes/gsd.yaml configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class GsdConfig:
    cli_path: str = "gsd"
    mcp_server_path: str = "gsd-mcp-server"
    credential_source: str = "gsd"
    default_project: str | None = None
    bindings: dict[str, dict[str, str]] = field(default_factory=dict)
    poll_interval_seconds: int = 12
    cache_ttl_seconds: int = 45
    mcp_read_timeout_seconds: float = 60.0
    notification_level: str = "normal"
    gsd_version_min: str = "2.53"
    gsd_version_max: str = "3.0"
    hermes_memory_path: str | None = None

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> GsdConfig:
        gsd = raw.get("gsd") or raw
        return cls(
            cli_path=str(gsd.get("cli_path", "gsd")),
            mcp_server_path=str(gsd.get("mcp_server_path", "gsd-mcp-server")),
            credential_source=str(gsd.get("credential_source", "gsd")),
            default_project=gsd.get("default_project"),
            bindings=dict(gsd.get("bindings") or {}),
            poll_interval_seconds=int(gsd.get("poll_interval_seconds", 12)),
            cache_ttl_seconds=int(gsd.get("cache_ttl_seconds", 45)),
            mcp_read_timeout_seconds=float(gsd.get("mcp_read_timeout_seconds", 60.0)),
            notification_level=str(gsd.get("notification_level", "normal")),
            gsd_version_min=str(gsd.get("gsd_version_min", "2.53")),
            gsd_version_max=str(gsd.get("gsd_version_max", "3.0")),
            hermes_memory_path=gsd.get("hermes_memory_path"),
        )


def config_path() -> Path:
    explicit = os.environ.get("HERMES_GSD_CONFIG")
    if explicit:
        return Path(explicit).expanduser()
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    return hermes_home.expanduser() / "gsd.yaml"


def load_config(path: Path | None = None) -> GsdConfig:
    cfg_path = path or config_path()
    if not cfg_path.exists():
        return GsdConfig()
    with cfg_path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return GsdConfig.from_dict(data)
