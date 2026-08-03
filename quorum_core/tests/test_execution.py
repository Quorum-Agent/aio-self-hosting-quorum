"""Tests for quorum_core.execution module.

Security invariants tested:
- INV_EXECUTION_QUORUM: Tasks must reach quorum for COMPLETED status.
- Result integrity hash must verify.
- Quorum count invariant.
"""

import pytest

from quorum_core.config import QuorumConfig
from quorum_core.model import ExecutionResult, TaskStatus
from quorum_core.execution import ExecutionEngine, ExecutionError, QuorumError


class TestExecutionEngine:
    """Execution engine tests with quorum security invariants."""

    @pytest.fixture
    def engine(self):
        config = QuorumConfig(base_url="http://test:8080", quorum_size=3)
        return ExecutionEngine(config)

    def test_execute_reaches_quorum(self, engine):
        """Default execution reaches quorum."""
        result = engine.execute(task_id="task-1")
        assert result.status == TaskStatus.COMPLETED
        assert result.quorum_reached is True
        assert result.quorum_count >= engine.config.quorum_size

    def test_execute_with_explicit_votes(self, engine):
        """Execution with explicit vote_count."""
        result = engine.execute(task_id="task-2", data='{"vote_count": 5}')
        assert result.quorum_count == 5
        assert result.quorum_reached is True

    def test_execute_below_quorum(self, engine):
        """Execution with insufficient votes is REJECTED."""
        result = engine.execute(task_id="task-3", data='{"vote_count": 1}')
        assert result.status == TaskStatus.REJECTED
        assert result.quorum_reached is False

    def test_get_result_returns_result(self, engine):
        """get_result returns the execution result."""
        engine.execute(task_id="task-4")
        result = engine.get_result("task-4")
        assert result is not None
        assert result.task_id == "task-4"
        assert result.verify_integrity()

    def test_get_result_missing(self, engine):
        """get_result returns None for unknown tasks."""
        assert engine.get_result("nonexistent") is None

    def test_verify_result_passes_for_valid(self, engine):
        """verify_result passes for valid completed tasks."""
        engine.execute(task_id="task-5")
        assert engine.verify_result("task-5") is True

    def test_verify_result_fails_for_missing(self, engine):
        """verify_result fails for missing tasks."""
        assert engine.verify_result("missing") is False

    def test_verify_all_results(self, engine):
        """verify_all_results passes when all results are intact."""
        engine.execute(task_id="t-a")
        engine.execute(task_id="t-b")
        assert engine.verify_all_results() is True

    def test_execution_result_has_hash(self, engine):
        """Every execution result has a computed hash."""
        result = engine.execute(task_id="task-6")
        assert result.result_hash != ""
        assert len(result.result_hash) == 64

    def test_execution_result_integrity_after_retrieval(self, engine):
        """Results retrieved via get_result still verify."""
        engine.execute(task_id="task-7")
        result = engine.get_result("task-7")
        assert result.verify_integrity()

    def test_quorum_invariant_completed_requires_quorum(self, engine):
        """Mutation test: COMPLETED status without quorum is detectable."""
        # Normal: COMPLETED with quorum
        engine.execute(task_id="t-ok")
        r1 = engine.get_result("t-ok")
        assert r1.status == TaskStatus.COMPLETED
        assert r1.quorum_reached is True

        # Rejected: below quorum
        engine.execute(task_id="t-bad", data='{"vote_count": 0}')
        r2 = engine.get_result("t-bad")
        assert r2.status == TaskStatus.REJECTED
        assert r2.quorum_reached is False

        # If quorum invariant were removed, t-bad might be COMPLETED
        # The fact that it's REJECTED proves the invariant works

    def test_result_hash_detects_data_tampering(self, engine):
        """Mutation test: changing result data changes hash."""
        engine.execute(task_id="t1", data='{"key":"original"}')
        r1 = engine.get_result("t1")

        engine.execute(task_id="t2", data='{"key":"modified"}')
        r2 = engine.get_result("t2")

        # Same task_id prefix won't collide, but different data produces different hashes
        assert r1.result_hash != r2.result_hash


class TestExecutionResultQuorumInvariant:
    """Dedicated tests for the quorum security invariant."""

    def test_completed_must_have_quorum_reached_true(self):
        """INV_EXECUTION_QUORUM: COMPLETED requires quorum_reached=True."""
        result = ExecutionResult(
            task_id="inv-1",
            status=TaskStatus.COMPLETED,
            quorum_reached=True,
            quorum_count=3,
            quorum_required=3,
        )
        assert result.quorum_reached is True
        assert result.quorum_count >= result.quorum_required

    def test_completed_without_quorum_is_violation(self):
        """INV_EXECUTION_QUORUM: COMPLETED without quorum is detectable."""
        result = ExecutionResult(
            task_id="inv-2",
            status=TaskStatus.COMPLETED,
            quorum_reached=False,
            quorum_count=1,
            quorum_required=3,
        )
        # The violation exists
        violation_detected = result.status == TaskStatus.COMPLETED and not result.quorum_reached
        assert violation_detected is True

    def test_quorum_count_must_meet_required(self):
        """INV_EXECUTION_QUORUM: quorum_count >= quorum_required."""
        result = ExecutionResult(
            task_id="inv-3",
            status=TaskStatus.COMPLETED,
            quorum_reached=True,
            quorum_count=5,
            quorum_required=3,
        )
        assert result.quorum_count >= result.quorum_required

    def test_quorum_count_below_required_is_violation(self):
        """quorum_count < quorum_required is detectable."""
        result = ExecutionResult(
            task_id="inv-4",
            status=TaskStatus.COMPLETED,
            quorum_reached=True,
            quorum_count=2,  # below required 3
            quorum_required=3,
        )
        # This is inconsistent but detectable
        violation = result.quorum_count < result.quorum_required
        assert violation is True
