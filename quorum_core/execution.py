"""Execution engine for quorum_core.

Manages task execution with quorum-based consensus.
Security invariants ensure result integrity and quorum requirements.
"""

from __future__ import annotations

import json
import time
import threading
import queue
from dataclasses import dataclass, field
from typing import Optional, Callable

from quorum_core.config import QuorumConfig
from quorum_core.model import ExecutionResult, TaskStatus


class ExecutionError(Exception):
    """Raised when execution fails or quorum is not reached."""
    pass


class QuorumError(ExecutionError):
    """Raised when quorum requirements are not met."""
    pass


@dataclass
class ExecutionEngine:
    """Engine for executing tasks with quorum-based consensus.

    Security invariants:
    - Tasks must reach quorum before being marked COMPLETED.
    - Execution results carry integrity hashes.
    - Quorum count must equal or exceed quorum_required.
    - Result data cannot be modified after quorum is reached.
    """

    config: QuorumConfig
    _results: dict[str, ExecutionResult] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _handlers: dict[str, Callable] = field(default_factory=dict)

    def register_handler(self, task_type: str, handler: Callable) -> None:
        """Register a handler function for a task type."""
        self._handlers[task_type] = handler

    def execute(self, task_id: str, data: str = "{}") -> ExecutionResult:
        """Execute a task and collect quorum votes.

        The task is only marked COMPLETED when quorum is reached.
        If quorum is not reached, the task is marked REJECTED.

        Security invariant: quorum_count >= quorum_required for COMPLETED.
        """
        with self._lock:
            result = ExecutionResult(
                task_id=task_id,
                status=TaskStatus.RUNNING,
                quorum_required=self.config.quorum_size,
            )
            self._results[task_id] = result

        # Simulate collecting votes from nodes
        quorum_votes = self._collect_votes(task_id, data)

        with self._lock:
            quorum_reached = quorum_votes >= self.config.quorum_size
            new_status = TaskStatus.COMPLETED if quorum_reached else TaskStatus.REJECTED

            result = ExecutionResult(
                task_id=task_id,
                status=new_status,
                quorum_reached=quorum_reached,
                quorum_count=quorum_votes,
                quorum_required=self.config.quorum_size,
                data=data,
            )
            self._results[task_id] = result

        return result

    def _collect_votes(self, task_id: str, data: str) -> int:
        """Collect votes from available nodes.

        In a real implementation this would contact nodes over the network.
        Here we simulate with a simple count based on quorum_size.
        """
        try:
            task_data = json.loads(data)
        except json.JSONDecodeError:
            task_data = {}

        # If a vote_count is specified, use it (useful for testing)
        if "vote_count" in task_data:
            return int(task_data["vote_count"])

        # Default: simulate quorum being reached
        return self.config.quorum_size

    def get_result(self, task_id: str) -> Optional[ExecutionResult]:
        """Get the result of a task execution."""
        with self._lock:
            result = self._results.get(task_id)
            if result is None:
                return None
            # Security invariant: verify integrity on every access
            if not result.verify_integrity():
                raise ExecutionError(f"Result integrity check failed for task {task_id}")
            return result

    def verify_result(self, task_id: str) -> bool:
        """Verify the integrity and quorum status of a result.

        Returns True if:
        - The result exists
        - The integrity hash is valid
        - If COMPLETED, quorum_count >= quorum_required
        - If COMPLETED, quorum_reached is True
        """
        with self._lock:
            result = self._results.get(task_id)
            if result is None:
                return False

            # Integrity check
            if not result.verify_integrity():
                return False

            # Quorum invariant: COMPLETED must have quorum
            if result.status == TaskStatus.COMPLETED:
                if not result.quorum_reached:
                    return False
                if result.quorum_count < result.quorum_required:
                    return False

            return True

    def verify_all_results(self) -> bool:
        """Verify integrity of all stored execution results."""
        with self._lock:
            return all(r.verify_integrity() for r in self._results.values())
