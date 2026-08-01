"""Python port of Quorum's types/policies/route-planner — spike 001.

Faithful 1:1 port of packages/core/src/{types,policies,route-planner}.ts.
The point is not elegance; it is that the SAME decisions come out of the
Python implementation as come out of the TS one, verified against the same
scenarios the TS mutation suite pins.
"""

from .types import (
    EXECUTION_LOCATIONS,
    ModelDescriptor,
    PolicyDefinition,
    leaves_device,
    location_tier,
    model_reach,
)
from .policies import POLICIES, get_policy
from .planner import CompiledRequest, Planner, PlanResult, Requirements

__all__ = [
    "EXECUTION_LOCATIONS",
    "ModelDescriptor",
    "PolicyDefinition",
    "leaves_device",
    "location_tier",
    "model_reach",
    "POLICIES",
    "get_policy",
    "CompiledRequest",
    "Planner",
    "PlanResult",
    "Requirements",
]
