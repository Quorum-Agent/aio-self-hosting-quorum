import type { PolicyDefinition, PolicyMode } from "./types.js";

export const POLICIES: Record<PolicyMode, PolicyDefinition> = {
  private: {
    id: "private",
    label: "Private",
    description: "Keep inference and tools on this machine.",
    allowNetwork: false,
    allowCloudModels: false,
    preferLocal: true,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description:
      "Prefer local execution; allow automatic web search and cloud only when they add clear value.",
    allowNetwork: true,
    allowCloudModels: true,
    preferLocal: true,
  },
  quality: {
    id: "quality",
    label: "Best quality",
    description: "Choose the strongest available route for each request.",
    allowNetwork: true,
    allowCloudModels: true,
    preferLocal: false,
  },
  offline: {
    id: "offline",
    label: "Offline",
    description: "Disable every network operation, including local network endpoints.",
    allowNetwork: false,
    allowCloudModels: false,
    preferLocal: true,
  },
  cost_controlled: {
    id: "cost_controlled",
    label: "Cost controlled",
    description: "Prefer free local routes and cap exceptional cloud use.",
    allowNetwork: true,
    allowCloudModels: true,
    preferLocal: true,
    cloudBudgetUsd: 1,
  },
};

export function getPolicy(mode: PolicyMode): PolicyDefinition {
  return POLICIES[mode];
}
