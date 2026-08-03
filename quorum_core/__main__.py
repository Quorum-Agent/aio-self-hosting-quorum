"""quorum_core CLI entry point.

Run with: python -m quorum_core [command]
"""

import sys
import argparse
import json

from quorum_core.config import QuorumConfig
from quorum_core.model import Node, Policy, ExecutionResult, NodeStatus
from quorum_core.policy import PolicyEngine
from quorum_core.execution import ExecutionEngine
from quorum_core.discovery import DiscoveryService
from quorum_core.security import SecurityVerifier


def cmd_config(args):
    """Print current configuration."""
    cfg = QuorumConfig.load()
    print(json.dumps(cfg.to_dict(), indent=2))


def cmd_discover(args):
    """Run service discovery."""
    cfg = QuorumConfig.load()
    ds = DiscoveryService(cfg)
    nodes = ds.discover()
    for node in nodes:
        print(f"  {node.id} @ {node.address} [{node.status.value}]")


def cmd_policy_validate(args):
    """Validate a policy."""
    cfg = QuorumConfig.load()
    engine = PolicyEngine(cfg)
    policy = engine.load_policy(args.policy)
    result = engine.validate(policy)
    print(f"Policy {policy.id}: valid={result}")


def cmd_execute(args):
    """Execute a task with quorum."""
    cfg = QuorumConfig.load()
    engine = ExecutionEngine(cfg)
    result = engine.execute(args.task_id, args.data)
    print(f"Execution {result.task_id}: status={result.status.value}, quorum={result.quorum_reached}")


def cmd_security_verify(args):
    """Run security invariant checks."""
    verifier = SecurityVerifier()
    passed = verifier.verify_all()
    print(f"Security verification: {'PASSED' if passed else 'FAILED'}")
    for inv in verifier.invariants:
        print(f"  {inv.name}: {'OK' if inv.passed else 'FAIL'} - {inv.description}")


def main():
    parser = argparse.ArgumentParser(prog="quorum_core", description="Quorum Core CLI")
    sub = parser.add_subparsers(dest="command", help="Commands")

    p_config = sub.add_parser("config", help="Show configuration")
    p_config.set_defaults(func=cmd_config)

    p_discover = sub.add_parser("discover", help="Discover nodes")
    p_discover.set_defaults(func=cmd_discover)

    p_validate = sub.add_parser("validate", help="Validate a policy")
    p_validate.add_argument("policy", help="Policy name")
    p_validate.set_defaults(func=cmd_policy_validate)

    p_exec = sub.add_parser("execute", help="Execute a task")
    p_exec.add_argument("task_id", help="Task ID")
    p_exec.add_argument("--data", default="{}", help="Task data JSON")
    p_exec.set_defaults(func=cmd_execute)

    p_security = sub.add_parser("security-verify", help="Run security invariant checks")
    p_security.set_defaults(func=cmd_security_verify)

    args = parser.parse_args()
    if hasattr(args, "func"):
        args.func(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
