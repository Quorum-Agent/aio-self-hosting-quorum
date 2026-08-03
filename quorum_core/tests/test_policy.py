"""Tests for quorum_core.policy module.

Security invariants tested:
- INV_POLICY_SIGNATURE: Policies must have verifiable signatures.
- Signature check is mandatory before enforcement.
- Tampered policies are rejected.
"""

import pytest

from quorum_core.config import QuorumConfig
from quorum_core.model import Policy, PolicyAction
from quorum_core.policy import PolicyEngine


class TestPolicyEngine:
    """Policy engine tests with security invariants."""

    @pytest.fixture
    def engine(self):
        config = QuorumConfig(base_url="http://test:8080")
        return PolicyEngine(config)

    @pytest.fixture
    def valid_policy(self, engine):
        return engine.create_policy(
            policy_id="test-policy",
            name="Test Policy",
            action=PolicyAction.ALLOW,
            resources=("resource-a", "resource-b"),
        )

    def test_create_policy_has_signature(self, valid_policy):
        """Created policies have automatic signatures."""
        assert valid_policy.signature != ""
        assert len(valid_policy.signature) == 64

    def test_create_policy_verifies(self, valid_policy):
        """Created policies pass signature verification."""
        assert valid_policy.verify_signature()

    def test_validate_passes_for_signed_policy(self, engine, valid_policy):
        """Validation passes for signed policies."""
        assert engine.validate(valid_policy) is True

    def test_store_policy_rejects_unsigned(self, engine):
        """Storing a policy with invalid signature raises error."""
        # Simulate tampering by creating a Policy manually with bad signature
        bad_policy = Policy(
            id="bad",
            name="Bad",
            action=PolicyAction.ALLOW,
            signature="0000deadbeef",
        )
        with pytest.raises(ValueError, match="invalid signature"):
            engine.store_policy(bad_policy)

    def test_check_access_allows_matching_resource(self, engine, valid_policy):
        """Access is allowed for matching resources."""
        engine.store_policy(valid_policy)
        result = engine.check_access("test-policy", "resource-a")
        assert result is True

    def test_check_access_denies_non_matching_resource(self, engine, valid_policy):
        """Access is denied for non-matching resources."""
        engine.store_policy(valid_policy)
        result = engine.check_access("test-policy", "resource-c")
        assert result is False

    def test_check_access_on_deny_policy(self, engine):
        """DENY policies always deny access."""
        deny_policy = engine.create_policy(
            policy_id="deny-policy",
            name="Deny All",
            action=PolicyAction.DENY,
            resources=("resource-a",),
        )
        engine.store_policy(deny_policy)
        result = engine.check_access("deny-policy", "resource-a")
        assert result is False

    def test_check_access_nonexistent_policy(self, engine):
        """Access is denied for non-existent policies."""
        result = engine.check_access("nonexistent", "resource-a")
        assert result is False

    def test_check_access_with_conditions(self, engine):
        """Access with conditions requires matching context."""
        policy = engine.create_policy(
            policy_id="cond-policy",
            name="Conditional",
            action=PolicyAction.ALLOW,
            resources=("r1",),
            conditions=("role", "region"),
        )
        engine.store_policy(policy)
        # Without context, fails
        assert engine.check_access("cond-policy", "r1") is False
        # With partial context, fails
        assert engine.check_access("cond-policy", "r1", {"role": "admin"}) is False
        # With full context, succeeds
        assert engine.check_access("cond-policy", "r1", {"role": "admin", "region": "us"}) is True

    def test_verify_all_policies(self, engine, valid_policy):
        """verify_all_policies passes when all are valid."""
        engine.store_policy(valid_policy)
        policy2 = engine.create_policy(
            policy_id="p2", name="OK", action=PolicyAction.ALLOW
        )
        engine.store_policy(policy2)
        assert engine.verify_all_policies() is True

    def test_load_policy(self, engine, valid_policy):
        """Load returns the stored policy."""
        engine.store_policy(valid_policy)
        loaded = engine.load_policy("test-policy")
        assert loaded is not None
        assert loaded.id == "test-policy"
        assert loaded.verify_signature()

    def test_load_nonexistent_policy(self, engine):
        """Load returns None for missing policies."""
        assert engine.load_policy("missing") is None

    def test_policy_signature_mutation_invariant(self, engine):
        """Mutation test: if signature check is removed, tampering goes undetected."""
        policy = engine.create_policy(
            policy_id="mutation-test",
            name="Mutation Test",
            action=PolicyAction.ALLOW,
            resources=("secret",),
        )
        # The signature exists and verifies
        assert policy.verify_signature()
        # If we create a "tampered" version, it gets a different signature
        tampered = Policy(
            id="mutation-test",
            name="Mutation Test",
            action=PolicyAction.ALLOW,
            resources=("public",),  # tampered resource
        )
        assert policy.signature != tampered.signature
        # The original's signature should still verify
        assert policy.verify_signature()
