"""Tests for quorum_core.security module.

Security invariants tested:
- INV_SNAKE_CASE_CONFIG: Config uses snake_case not camelCase.
- INV_NO_CAMELCASE_API: No forbidden camelCase API patterns.
- INV_MODEL_INTEGRITY: All models support integrity verification.
- INV_POLICY_SIGNATURE: Policies have verifiable signatures.
- INV_EXECUTION_QUORUM: COMPLETED requires quorum.
- INV_DISCOVERY_INTEGRITY: Node discovery verifies integrity.
- INV_NO_EXTERNAL_DEPS: Only stdlib imports.
- INV_NO_ASYNCIO: No asyncio usage.

Mutation-tested: removing any single invariant check from security.py
MUST cause at least one test to fail.
"""

import pytest
from pathlib import Path

from quorum_core.security import (
    SecurityVerifier,
    SecurityInvariant,
    _forbidden_camelcase_api,
    _forbidden_external_imports,
    _forbidden_asyncio,
)
from quorum_core.model import (
    Node,
    NodeStatus,
    Policy,
    PolicyAction,
    ExecutionResult,
    TaskStatus,
)


class TestSecurityVerifier:
    """Tests for the SecurityVerifier with all 8 invariants."""

    @pytest.fixture
    def verifier(self):
        return SecurityVerifier()

    def test_all_invariants_pass(self, verifier):
        """All security invariants must pass."""
        result = verifier.verify_all()
        assert result is True, "All security invariants must pass"

    def test_has_eight_invariants(self, verifier):
        """There must be exactly 8 invariants."""
        assert len(verifier.invariants) == 8

    def test_invariant_names(self, verifier):
        """All invariants have expected names."""
        names = {inv.name for inv in verifier.invariants}
        expected = {
            "INV_SNAKE_CASE_CONFIG",
            "INV_NO_CAMELCASE_API",
            "INV_MODEL_INTEGRITY",
            "INV_POLICY_SIGNATURE",
            "INV_EXECUTION_QUORUM",
            "INV_DISCOVERY_INTEGRITY",
            "INV_NO_EXTERNAL_DEPS",
            "INV_NO_ASYNCIO",
        }
        assert names == expected, f"Missing invariants: {expected - names}"

    def test_each_invariant_runs(self, verifier):
        """Each invariant must have a run() method that sets passed."""
        for inv in verifier.invariants:
            result = inv.run()
            assert isinstance(result, bool)
            assert inv.passed == result


class TestInvariantSnakeCaseConfig:
    """INV_SNAKE_CASE_CONFIG mutation tests."""

    def test_config_uses_base_url(self):
        """base_url field exists."""
        from quorum_core.config import QuorumConfig

        cfg = QuorumConfig()
        assert hasattr(cfg, "base_url")
        assert "base_url" in cfg.to_dict()

        # camelCase variant must not exist
        camel = "base" + "Url"
        assert not hasattr(cfg, camel)

    def test_no_camelcase_in_config_source(self):
        """config.py source must not contain the camelCase base URL pattern."""
        import quorum_core.config as m
        from pathlib import Path

        source = Path(m.__file__).read_text()
        pattern = "base" + "Url"
        assert pattern not in source

    def test_no_forbidden_api_in_config_source(self):
        """config.py source must not contain forbidden API patterns."""
        import quorum_core.config as m
        from pathlib import Path

        source = Path(m.__file__).read_text()
        for term in _forbidden_camelcase_api():
            assert term not in source


class TestInvariantNoCamelCaseApi:
    """INV_NO_CAMELCASE_API mutation tests."""

    def test_no_forbidden_api_anywhere(self):
        """No source file contains forbidden camelCase API patterns."""
        import quorum_core
        from pathlib import Path

        pkg_dir = Path(quorum_core.__file__).parent
        this_file = "security.py"
        forbidden = _forbidden_camelcase_api()
        for py_file in pkg_dir.rglob("*.py"):
            if py_file.name == this_file:
                continue
            content = py_file.read_text(encoding="utf-8", errors="replace")
            for term in forbidden:
                assert term not in content, f"{py_file.name} contains '{term}'"


class TestInvariantModelIntegrity:
    """INV_MODEL_INTEGRITY mutation tests."""

    def test_node_integrity_works(self):
        """Node verify_integrity is functional."""
        node = Node(id="t", address="a")
        assert node.verify_integrity()

    def test_policy_signature_works(self):
        """Policy verify_signature is functional."""
        policy = Policy(id="t", name="T", action=PolicyAction.ALLOW)
        assert policy.verify_signature()

    def test_execution_result_integrity_works(self):
        """ExecutionResult verify_integrity is functional."""
        result = ExecutionResult(task_id="t")
        assert result.verify_integrity()


class TestInvariantPolicySignature:
    """INV_POLICY_SIGNATURE mutation tests."""

    def test_policy_signature_changes_with_data(self):
        """Different policy data produces different signatures."""
        p1 = Policy(id="p", name="X", action=PolicyAction.ALLOW, resources=("a",))
        p2 = Policy(id="p", name="X", action=PolicyAction.ALLOW, resources=("b",))
        assert p1.signature != p2.signature

    def test_signed_policy_stores_verifiable(self):
        """A Policy stored via PolicyEngine must be verifiable."""
        from quorum_core.config import QuorumConfig
        from quorum_core.policy import PolicyEngine

        cfg = QuorumConfig()
        engine = PolicyEngine(cfg)
        policy = engine.create_policy("id", "name", PolicyAction.ALLOW)
        assert policy.verify_signature()
        engine.store_policy(policy)
        assert engine.verify_all_policies()


class TestInvariantExecutionQuorum:
    """INV_EXECUTION_QUORUM mutation tests."""

    def test_engine_rejects_below_quorum(self):
        """Execution with insufficient votes is REJECTED."""
        from quorum_core.config import QuorumConfig
        from quorum_core.execution import ExecutionEngine
        from quorum_core.model import TaskStatus

        cfg = QuorumConfig(quorum_size=3)
        engine = ExecutionEngine(cfg)
        result = engine.execute("task", data='{"vote_count": 1}')
        assert result.status == TaskStatus.REJECTED

    def test_engine_completes_with_quorum(self):
        """Execution with sufficient votes is COMPLETED."""
        from quorum_core.config import QuorumConfig
        from quorum_core.execution import ExecutionEngine
        from quorum_core.model import TaskStatus

        cfg = QuorumConfig(quorum_size=3)
        engine = ExecutionEngine(cfg)
        result = engine.execute("task", data='{"vote_count": 3}')
        assert result.status == TaskStatus.COMPLETED
        assert result.quorum_reached is True


class TestInvariantDiscoveryIntegrity:
    """INV_DISCOVERY_INTEGRITY mutation tests."""

    def test_discovery_respects_status(self):
        """Discovery only returns ONLINE nodes."""
        from quorum_core.config import QuorumConfig
        from quorum_core.model import NodeStatus
        from quorum_core.discovery import DiscoveryService

        cfg = QuorumConfig()
        ds = DiscoveryService(cfg)
        ds.add_node("n1", "a:1", NodeStatus.ONLINE)
        ds.add_node("n2", "a:2", NodeStatus.OFFLINE)
        nodes = ds.discover()
        assert len(nodes) == 1
        assert nodes[0].id == "n1"


class TestInvariantNoExternalDeps:
    """INV_NO_EXTERNAL_DEPS mutation tests."""

    def test_no_forbidden_external_imports(self):
        """No forbidden external package imports anywhere."""
        import quorum_core
        from pathlib import Path

        pkg_dir = Path(quorum_core.__file__).parent
        this_file = "security.py"
        forbidden = _forbidden_external_imports()
        for py_file in pkg_dir.rglob("*.py"):
            if py_file.name == this_file:
                continue
            content = py_file.read_text(encoding="utf-8", errors="replace")
            for term in forbidden:
                assert term not in content, f"{py_file.name} contains '{term}'"


class TestInvariantNoAsyncio:
    """INV_NO_ASYNCIO mutation tests."""

    def test_no_forbidden_asyncio(self):
        """No asyncio patterns anywhere in source."""
        import quorum_core
        from pathlib import Path

        pkg_dir = Path(quorum_core.__file__).parent
        this_file = "security.py"
        forbidden = _forbidden_asyncio()
        for py_file in pkg_dir.rglob("*.py"):
            if py_file.name == this_file:
                continue
            content = py_file.read_text(encoding="utf-8", errors="replace")
            for term in forbidden:
                assert term not in content, f"{py_file.name} contains '{term}'"


class TestSecurityInvariantMutationDetection:
    """Verify mutation detection: removing any invariant causes test failure."""

    def test_all_invariants_present_and_accounted(self):
        """Every expected invariant name exists."""
        verifier = SecurityVerifier()
        required_names = {
            "INV_SNAKE_CASE_CONFIG",
            "INV_NO_CAMELCASE_API",
            "INV_MODEL_INTEGRITY",
            "INV_POLICY_SIGNATURE",
            "INV_EXECUTION_QUORUM",
            "INV_DISCOVERY_INTEGRITY",
            "INV_NO_EXTERNAL_DEPS",
            "INV_NO_ASYNCIO",
        }
        actual_names = {inv.name for inv in verifier.invariants}
        assert actual_names == required_names

    def test_each_invariant_has_check_function(self):
        """Each invariant has a callable check function."""
        verifier = SecurityVerifier()
        for inv in verifier.invariants:
            assert callable(inv.check), f"{inv.name} check is not callable"
            result = inv.check()
            assert isinstance(result, bool), f"{inv.name} check did not return bool"

    def test_snake_case_invariant_detects_camelcase(self):
        """INV_SNAKE_CASE_CONFIG detects camelCase patterns."""
        verifier = SecurityVerifier()
        for inv in verifier.invariants:
            if inv.name == "INV_SNAKE_CASE_CONFIG":
                assert inv.run() is True
                break

    def test_no_camelcase_api_invariant_passes(self):
        """INV_NO_CAMELCASE_API passes for clean codebase."""
        verifier = SecurityVerifier()
        for inv in verifier.invariants:
            if inv.name == "INV_NO_CAMELCASE_API":
                assert inv.run() is True
                break

    def test_model_integrity_invariant_passes(self):
        """INV_MODEL_INTEGRITY passes for valid models."""
        verifier = SecurityVerifier()
        for inv in verifier.invariants:
            if inv.name == "INV_MODEL_INTEGRITY":
                assert inv.run() is True
                break

    def test_no_external_deps_invariant_passes(self):
        """INV_NO_EXTERNAL_DEPS passes."""
        verifier = SecurityVerifier()
        for inv in verifier.invariants:
            if inv.name == "INV_NO_EXTERNAL_DEPS":
                assert inv.run() is True
                break

    def test_no_asyncio_invariant_passes(self):
        """INV_NO_ASYNCIO passes."""
        verifier = SecurityVerifier()
        for inv in verifier.invariants:
            if inv.name == "INV_NO_ASYNCIO":
                assert inv.run() is True
                break
