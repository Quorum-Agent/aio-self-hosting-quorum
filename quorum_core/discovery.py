"""Service discovery for quorum_core.

Finds and tracks nodes in the quorum network.
Security invariants ensure node identity integrity.
"""

from __future__ import annotations

import time
import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from quorum_core.config import QuorumConfig
from quorum_core.model import Node, NodeStatus


@dataclass
class DiscoveryService:
    """Service for discovering and tracking quorum nodes.

    Security invariants:
    - Nodes must pass integrity verification before being trusted.
    - Node status changes require integrity re-computation.
    - Stale nodes are detected and marked OFFLINE.
    """

    config: QuorumConfig
    _nodes: dict[str, Node] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def add_node(self, node_id: str, address: str, status: NodeStatus = NodeStatus.ONLINE) -> Node:
        """Add or update a node in the discovery registry.

        Creates a new Node with integrity hash computed automatically.
        """
        node = Node(id=node_id, address=address, status=status)
        with self._lock:
            self._nodes[node_id] = node
        return node

    def remove_node(self, node_id: str) -> bool:
        """Remove a node from the registry."""
        with self._lock:
            if node_id in self._nodes:
                del self._nodes[node_id]
                return True
            return False

    def get_node(self, node_id: str) -> Optional[Node]:
        """Get a node by ID.

        Returns None if the node is not found or fails integrity check.
        """
        with self._lock:
            node = self._nodes.get(node_id)
            if node is None:
                return None
            # Security invariant: verify integrity before returning
            if not node.verify_integrity():
                return None
            return node

    def discover(self) -> list[Node]:
        """Discover all available nodes.

        Only returns nodes that pass integrity verification.
        Stale nodes are marked OFFLINE.
        """
        cutoff = time.time() - self.config.timeout_seconds
        active: list[Node] = []

        with self._lock:
            for node_id, node in list(self._nodes.items()):
                # Skip integrity-failed nodes
                if not node.verify_integrity():
                    continue

                # Mark stale nodes
                if node.last_seen < cutoff and node.status != NodeStatus.OFFLINE:
                    node = node.with_status(NodeStatus.OFFLINE)
                    self._nodes[node_id] = node

                if node.status == NodeStatus.ONLINE:
                    active.append(node)

        return active

    def update_node_status(self, node_id: str, status: NodeStatus) -> Optional[Node]:
        """Update a node's status (creates new Node preserving integrity)."""
        with self._lock:
            existing = self._nodes.get(node_id)
            if existing is None:
                return None
            if not existing.verify_integrity():
                return None
            new_node = existing.with_status(status)
            self._nodes[node_id] = new_node
            return new_node

    def verify_all_nodes(self) -> bool:
        """Verify integrity of all registered nodes.

        Returns True only if ALL nodes pass integrity checks.
        """
        with self._lock:
            return all(n.verify_integrity() for n in self._nodes.values())

    def node_count(self) -> int:
        """Get the count of online nodes that pass integrity checks."""
        return len(self.discover())

    def load_from_file(self, path: str) -> int:
        """Load nodes from a JSON file. Returns count of loaded nodes."""
        file_path = Path(path)
        count = 0
        if file_path.exists():
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            for entry in data:
                node = Node(
                    id=entry["id"],
                    address=entry["address"],
                    status=NodeStatus(entry.get("status", "unknown")),
                )
                with self._lock:
                    self._nodes[node.id] = node
                count += 1
        return count
