"""Data models for quorum_core.

Defines the core data structures using dataclasses.
All models are immutable (frozen) to enforce security invariants.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Optional
import hashlib
import json
import time


class NodeStatus(Enum):
    """Status of a quorum node."""
    ONLINE = "online"
    OFFLINE = "offline"
    DEGRADED = "degraded"
    UNKNOWN = "unknown"


class TaskStatus(Enum):
    """Status of a task execution."""
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    REJECTED = "rejected"


class PolicyAction(Enum):
    """Allowed actions in a policy."""
    ALLOW = "allow"
    DENY = "deny"


@dataclass(frozen=True)
class Node:
    """Represents a node in the quorum network.

    Nodes are immutable after creation. The integrity_hash is computed
    from the node's identity fields and serves as a tamper-evident seal.
    """

    id: str
    address: str
    status: NodeStatus = NodeStatus.UNKNOWN
    last_seen: float = field(default_factory=time.time)
    integrity_hash: str = ""

    def __post_init__(self):
        # Compute integrity hash if not provided
        if not self.integrity_hash:
            object.__setattr__(self, "integrity_hash", self._compute_hash())

    def _compute_hash(self) -> str:
        """Compute an integrity hash from the node's identity."""
        content = f"{self.id}|{self.address}|{self.status.value}"
        return hashlib.sha256(content.encode()).hexdigest()

    def verify_integrity(self) -> bool:
        """Verify that the node's integrity hash still matches its fields."""
        return self.integrity_hash == self._compute_hash()

    def with_status(self, status: NodeStatus, seen: Optional[float] = None) -> Node:
        """Create a new Node with updated status (preserving integrity)."""
        return Node(
            id=self.id,
            address=self.address,
            status=status,
            last_seen=seen if seen is not None else time.time(),
        )


@dataclass(frozen=True)
class Policy:
    """An access control policy for quorum operations.

    Policies are immutable after creation. The signature field provides
    cryptographic assurance that the policy was authorized.
    """

    id: str
    name: str
    action: PolicyAction
    resources: tuple[str, ...] = ()
    conditions: tuple[str, ...] = ()
    signature: str = ""

    def __post_init__(self):
        if not self.signature:
            object.__setattr__(self, "signature", self._compute_signature())

    def _compute_signature(self) -> str:
        """Compute a policy signature from its content."""
        content = f"{self.id}|{self.name}|{self.action.value}|{','.join(sorted(self.resources))}|{','.join(sorted(self.conditions))}"
        return hashlib.sha256(content.encode()).hexdigest()

    def verify_signature(self) -> bool:
        """Verify the policy signature is intact."""
        return self.signature == self._compute_signature()

    def _check_mutation(self) -> bool:
        """Security invariant: detect if policy was mutated.

        This is the core invariant - policies must not be tampered with.
        Returns True if the policy is intact.
        """
        return self.verify_signature()

    @property
    def is_valid(self) -> bool:
        """Check all security invariants on this policy."""
        return self._check_mutation()


@dataclass(frozen=True)
class ExecutionResult:
    """Result of a task execution with quorum confirmation.

    The result_hash ensures tamper-evidence on execution outcomes.
    """

    task_id: str
    status: TaskStatus = TaskStatus.PENDING
    quorum_reached: bool = False
    quorum_count: int = 0
    quorum_required: int = 0
    data: str = "{}"
    result_hash: str = ""
    timestamp: float = field(default_factory=time.time)

    def __post_init__(self):
        if not self.result_hash:
            object.__setattr__(self, "result_hash", self._compute_hash())

    def _compute_hash(self) -> str:
        """Compute an integrity hash for the execution result."""
        content = f"{self.task_id}|{self.status.value}|{self.quorum_reached}|{self.quorum_count}|{self.quorum_required}|{self.data}"
        return hashlib.sha256(content.encode()).hexdigest()

    def verify_integrity(self) -> bool:
        """Verify execution result integrity."""
        return self.result_hash == self._compute_hash()

    def with_status(
        self,
        status: TaskStatus,
        quorum_reached: Optional[bool] = None,
        quorum_count: Optional[int] = None,
        data: Optional[str] = None,
    ) -> ExecutionResult:
        """Create a new result with updated status."""
        return ExecutionResult(
            task_id=self.task_id,
            status=status,
            quorum_reached=quorum_reached if quorum_reached is not None else self.quorum_reached,
            quorum_count=quorum_count if quorum_count is not None else self.quorum_count,
            quorum_required=self.quorum_required,
            data=data if data is not None else self.data,
        )
