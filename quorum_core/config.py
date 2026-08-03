"""Configuration management for quorum_core.

Uses `base_url` (snake_case) for API endpoint configuration.
Config values are immutable after construction.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class QuorumCoreConfig:
    """Nested configuration for quorum core settings.

    Provides the quorum_core.quorum_size access pattern used by
    the main repo's execution engine.
    """

    quorum_size: int = 3


@dataclass(frozen=True)
class QuorumConfig:
    """Configuration for quorum_core.

    Attributes:
        base_url: Base URL for the quorum API endpoint (uses snake_case).
        quorum_size: Minimum number of nodes required for quorum.
        quorum_core: Nested config (quorum_core.quorum_size for main repo compat).
        timeout_seconds: Timeout for operations in seconds.
        discovery_interval_seconds: Interval between discovery cycles.
        max_retries: Maximum retry attempts for failed operations.
        verify_ssl: Whether to verify SSL certificates.
    """

    base_url: str = "http://localhost:8080"
    quorum_size: int = 3
    quorum_core: QuorumCoreConfig = field(default_factory=QuorumCoreConfig)
    timeout_seconds: float = 30.0
    discovery_interval_seconds: float = 60.0
    max_retries: int = 3
    verify_ssl: bool = True

    def __post_init__(self):
        # Ensure quorum_core.quorum_size stays in sync with quorum_size.
        # This handles cases where quorum_size is overridden via constructor
        # but the default_factory for quorum_core used the class default.
        if self.quorum_core.quorum_size != self.quorum_size:
            object.__setattr__(
                self, "quorum_core", QuorumCoreConfig(quorum_size=self.quorum_size)
            )

    def to_dict(self) -> dict:
        """Serialize config to a dictionary (snake_case keys)."""
        return {
            "base_url": self.base_url,
            "quorum_size": self.quorum_size,
            "quorum_core": {"quorum_size": self.quorum_core.quorum_size},
            "timeout_seconds": self.timeout_seconds,
            "discovery_interval_seconds": self.discovery_interval_seconds,
            "max_retries": self.max_retries,
            "verify_ssl": self.verify_ssl,
        }

    @classmethod
    def from_dict(cls, data: dict) -> QuorumConfig:
        """Create config from a dictionary with snake_case keys."""
        # Support both flat quorum_size and nested quorum_core dict
        quorum_core_data = data.get("quorum_core", {})
        if isinstance(quorum_core_data, dict):
            quorum_size = int(data.get("quorum_size", quorum_core_data.get("quorum_size", 3)))
        else:
            quorum_size = int(data.get("quorum_size", 3))

        return cls(
            base_url=data.get("base_url", "http://localhost:8080"),
            quorum_size=quorum_size,
            timeout_seconds=float(data.get("timeout_seconds", 30.0)),
            discovery_interval_seconds=float(data.get("discovery_interval_seconds", 60.0)),
            max_retries=int(data.get("max_retries", 3)),
            verify_ssl=bool(data.get("verify_ssl", True)),
        )

    @classmethod
    def load(cls, path: Optional[str] = None) -> QuorumConfig:
        """Load configuration from a JSON file or environment.

        Priority: explicit path > QUORUM_CONFIG env var > default search.
        Only snake_case keys are accepted.
        """
        if path:
            config_path = Path(path)
        else:
            env_path = os.environ.get("QUORUM_CONFIG")
            if env_path:
                config_path = Path(env_path)
            else:
                search_paths = [
                    Path("quorum_config.json"),
                    Path.home() / ".quorum" / "config.json",
                ]
                config_path = next((p for p in search_paths if p.exists()), None)

        if config_path and config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return cls.from_dict(data)

        return cls()

    @classmethod
    def from_env(cls) -> QuorumConfig:
        """Create config from environment variables (QUORUM_ prefix, upper snake_case)."""
        return cls(
            base_url=os.environ.get("QUORUM_BASE_URL", "http://localhost:8080"),
            quorum_size=int(os.environ.get("QUORUM_QUORUM_SIZE", "3")),
            timeout_seconds=float(os.environ.get("QUORUM_TIMEOUT_SECONDS", "30.0")),
            discovery_interval_seconds=float(os.environ.get("QUORUM_DISCOVERY_INTERVAL_SECONDS", "60.0")),
            max_retries=int(os.environ.get("QUORUM_MAX_RETRIES", "3")),
            verify_ssl=os.environ.get("QUORUM_VERIFY_SSL", "true").lower() in ("true", "1", "yes"),
        )
