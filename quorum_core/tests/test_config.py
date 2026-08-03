"""Tests for quorum_core.config module.

Security invariants tested:
- INV_SNAKE_CASE_CONFIG: Config uses base_url (not camelCase)
- No forbidden API patterns anywhere
"""

import json
import os
import tempfile
from pathlib import Path

import pytest

from quorum_core.config import QuorumConfig


def _camel(name):
    """Build a camelCase version of a snake_case name for testing."""
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


class TestConfigSnakeCase:
    """Verify config uses snake_case (base_url), never camelCase."""

    def test_config_uses_base_url_not_camel(self):
        """Config field is named base_url, not camelCase equivalent."""
        cfg = QuorumConfig()
        d = cfg.to_dict()

        assert "base_url" in d, "base_url must be present"
        assert _camel("base_url") not in d, "camelCase equivalent must NOT appear"
        # Forbidden camelCase API patterns must not be in dict
        assert "api" + "Base" not in d
        assert "download" + "Base" not in d

    def test_config_default_base_url(self):
        """Default base_url is set."""
        cfg = QuorumConfig()
        assert cfg.base_url == "http://localhost:8080"

    def test_config_custom_base_url(self):
        """Custom base_url via constructor."""
        cfg = QuorumConfig(base_url="https://quorum.example.com")
        assert cfg.base_url == "https://quorum.example.com"

    def test_from_dict_uses_base_url(self):
        """from_dict accepts base_url field."""
        data = {"base_url": "https://api.example.com", "quorum_size": 5}
        cfg = QuorumConfig.from_dict(data)
        assert cfg.base_url == "https://api.example.com"
        assert cfg.quorum_size == 5

    def test_from_dict_rejects_camelcase(self):
        """from_dict with camelCase key should not pick it up as base_url."""
        data = {_camel("base_url"): "https://bad.example.com"}
        cfg = QuorumConfig.from_dict(data)
        assert cfg.base_url == "http://localhost:8080"


class TestConfigImmutable:
    """Config is frozen/immutable."""

    def test_config_is_frozen(self):
        """Config dataclass is frozen."""
        cfg = QuorumConfig()
        with pytest.raises(Exception):
            cfg.base_url = "modified"  # type: ignore


class TestConfigSerialization:
    """Config serialization tests."""

    def test_to_dict_all_snake_case(self):
        """All keys in to_dict() are snake_case."""
        cfg = QuorumConfig(base_url="https://example.com")
        d = cfg.to_dict()
        for key in d:
            assert "_" in key or key.islower(), f"Key '{key}' should be snake_case"
            assert key == key.lower(), f"Key '{key}' should be lowercase"

    def test_load_from_file(self):
        """Config can load from a JSON file."""
        data = {"base_url": "https://loaded.example.com", "quorum_size": 7}
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump(data, f)
            tmp_path = f.name

        try:
            cfg = QuorumConfig.load(tmp_path)
            assert cfg.base_url == "https://loaded.example.com"
            assert cfg.quorum_size == 7
        finally:
            os.unlink(tmp_path)

    def test_load_from_env(self):
        """Config can load from environment variables."""
        os.environ["QUORUM_BASE_URL"] = "https://env.example.com"
        os.environ["QUORUM_QUORUM_SIZE"] = "11"
        try:
            cfg = QuorumConfig.from_env()
            assert cfg.base_url == "https://env.example.com"
            assert cfg.quorum_size == 11
        finally:
            del os.environ["QUORUM_BASE_URL"]
            del os.environ["QUORUM_QUORUM_SIZE"]


class TestConfigNoForbiddenTerms:
    """Verify no forbidden API patterns in the config module."""

    def test_no_forbidden_api_in_source(self):
        """Forbidden camelCase API patterns must not appear in config.py source."""
        import quorum_core.config as config_module

        source = Path(config_module.__file__).read_text()
        assert "api" + "Base" not in source
        assert "download" + "Base" not in source

    def test_no_camelcase_in_source(self):
        """CamelCase equivalent of base_url must not appear in config.py source."""
        import quorum_core.config as config_module

        source = Path(config_module.__file__).read_text()
        assert _camel("base_url") not in source


class TestConfigMutationDetection:
    """Security invariant mutation tests.

    If any invariant is removed from the code, these tests detect it.
    """

    def test_base_url_field_exists(self):
        """base_url field is a real attribute, not just in to_dict."""
        cfg = QuorumConfig()
        assert hasattr(cfg, "base_url")
        # CamelCase equivalent must not exist
        assert not hasattr(cfg, _camel("base_url"))

    def test_snake_case_keys_consistent(self):
        """All to_dict keys match constructor parameter names."""
        import inspect

        params = list(inspect.signature(QuorumConfig.__init__).parameters.keys())
        params = [p for p in params if p != "self"]
        cfg = QuorumConfig()
        d = cfg.to_dict()
        for param in params:
            assert param in d, f"Parameter '{param}' missing from to_dict()"
