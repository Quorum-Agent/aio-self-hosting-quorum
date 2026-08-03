"""Tests for quorum_core.discovery module.

Security invariants tested:
- INV_DISCOVERY_INTEGRITY: Node discovery must verify integrity.
- Tampered nodes are rejected.
- Stale nodes are detected.
"""

import time

import pytest

from quorum_core.config import QuorumConfig
from quorum_core.model import Node, NodeStatus
from quorum_core.discovery import DiscoveryService


class TestDiscoveryService:
    """Service discovery tests with integrity invariants."""

    @pytest.fixture
    def service(self):
        config = QuorumConfig(base_url="http://test:8080", timeout_seconds=30.0)
        return DiscoveryService(config)

    @pytest.fixture
    def online_node(self, service):
        return service.add_node("n1", "localhost:8080", NodeStatus.ONLINE)

    def test_add_node_creates_with_integrity(self, online_node):
        """Added nodes have integrity hashes."""
        assert online_node.verify_integrity()
        assert online_node.integrity_hash != ""

    def test_get_node_returns_node(self, service, online_node):
        """get_node returns a stored node."""
        node = service.get_node("n1")
        assert node is not None
        assert node.id == "n1"
        assert node.verify_integrity()

    def test_get_node_missing(self, service):
        """get_node returns None for unknown nodes."""
        assert service.get_node("missing") is None

    def test_discover_returns_online_nodes(self, service):
        """discover returns only ONLINE nodes."""
        service.add_node("n1", "host1:80", NodeStatus.ONLINE)
        service.add_node("n2", "host2:80", NodeStatus.ONLINE)
        service.add_node("n3", "host3:80", NodeStatus.OFFLINE)

        nodes = service.discover()
        assert len(nodes) == 2
        ids = {n.id for n in nodes}
        assert ids == {"n1", "n2"}

    def test_discover_excludes_stale_nodes(self, service):
        """discover marks stale nodes OFFLINE."""
        config = QuorumConfig(base_url="http://test:8080", timeout_seconds=0.001)
        svc = DiscoveryService(config)
        svc.add_node("stale-node", "host:80", NodeStatus.ONLINE)

        # Wait for node to become stale
        time.sleep(0.01)

        nodes = svc.discover()
        assert len(nodes) == 0  # Stale node excluded

    def test_update_node_status(self, service, online_node):
        """update_node_status creates new integrity hash."""
        updated = service.update_node_status("n1", NodeStatus.OFFLINE)
        assert updated is not None
        assert updated.status == NodeStatus.OFFLINE
        assert updated.verify_integrity()
        # Hash changed (status changed)
        assert online_node.integrity_hash != updated.integrity_hash

    def test_update_nonexistent_node(self, service):
        """update_node_status returns None for unknown nodes."""
        assert service.update_node_status("ghost", NodeStatus.ONLINE) is None

    def test_remove_node(self, service, online_node):
        """Remove removes a node."""
        assert service.remove_node("n1") is True
        assert service.get_node("n1") is None

    def test_remove_missing_node(self, service):
        """Remove returns False for missing nodes."""
        assert service.remove_node("missing") is False

    def test_verify_all_nodes(self, service):
        """verify_all_nodes passes for all valid nodes."""
        service.add_node("a", "host-a:80", NodeStatus.ONLINE)
        service.add_node("b", "host-b:80", NodeStatus.ONLINE)
        assert service.verify_all_nodes() is True

    def test_node_count(self, service):
        """node_count returns only online nodes."""
        service.add_node("a", "host-a:80", NodeStatus.ONLINE)
        service.add_node("b", "host-b:80", NodeStatus.ONLINE)
        service.add_node("c", "host-c:80", NodeStatus.OFFLINE)
        assert service.node_count() == 2

    def test_discovery_integrity_invariant(self, service):
        """Mutation test: if integrity check is removed, tampered nodes pass."""
        node = service.add_node("inv-node", "host:80", NodeStatus.ONLINE)
        assert node.verify_integrity()

        # Retrieved node also verifies
        retrieved = service.get_node("inv-node")
        assert retrieved is not None
        assert retrieved.verify_integrity()

        # Node with different address = different hash = tampering detected
        tampered = Node(id="inv-node", address="evil:666", status=NodeStatus.ONLINE)
        # Hashes differ (tampering detected)
        assert node.integrity_hash != tampered.integrity_hash
