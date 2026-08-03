"""Policy engine for quorum_core.

Manages access control policies with integrity verification.
Policies must pass signature validation before being enforced.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from quorum_core.config import QuorumConfig
from quorum_core.model import Policy, PolicyAction


@dataclass
class PolicyEngine:
    """Engine for creating, loading, validating, and enforcing policies.

    Security invariants:
    - Policies must verify their signature before enforcement.
    - Only signed policies can be used for access decisions.
    - Policy mutation is detected via signature mismatch.
    """

    config: QuorumConfig

    def __init__(self, config: QuorumConfig):
        self.config = config
        self._policies: dict[str, Policy] = {}

    def create_policy(
        self,
        policy_id: str,
        name: str,
        action: PolicyAction,
        resources: tuple[str, ...] = (),
        conditions: tuple[str, ...] = (),
    ) -> Policy:
        """Create a new signed policy."""
        policy = Policy(
            id=policy_id,
            name=name,
            action=action,
            resources=resources,
            conditions=conditions,
        )
        self._policies[policy_id] = policy
        return policy

    def load_policy(self, policy_id: str) -> Optional[Policy]:
        """Load a policy by ID."""
        return self._policies.get(policy_id)

    def store_policy(self, policy: Policy) -> None:
        """Store a policy in the engine.

        Raises ValueError if the policy signature is invalid.
        """
        if not policy.verify_signature():
            raise ValueError(f"Policy {policy.id} has an invalid signature - possible tampering detected")
        self._policies[policy.id] = policy

    def validate(self, policy: Policy) -> bool:
        """Validate a policy's security invariants.

        Returns True if the policy is intact and can be enforced.
        """
        return policy.is_valid

    def check_access(self, policy_id: str, resource: str, context: dict | None = None) -> bool:
        """Check if a resource access is allowed by the policy.

        Returns True if the policy allows access, False otherwise.

        Raises ValueError if the policy's signature is invalid (tampering).
        """
        policy = self._policies.get(policy_id)
        if policy is None:
            return False

        # Security invariant: must verify signature before enforcement
        if not policy.verify_signature():
            raise ValueError(
                f"Policy {policy_id} signature verification failed - "
                f"policy may have been tampered with"
            )

        if policy.action == PolicyAction.DENY:
            return False

        if policy.resources and resource not in policy.resources:
            return False

        if policy.conditions:
            if not context:
                return False
            for condition in policy.conditions:
                if condition not in context:
                    return False

        return True

    def verify_all_policies(self) -> bool:
        """Verify signature integrity of all stored policies.

        Returns True only if ALL policies pass verification.
        """
        return all(p.verify_signature() for p in self._policies.values())
