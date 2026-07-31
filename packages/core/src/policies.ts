import type { PolicyDefinition, PolicyMode } from "./types.js";

/**
 * Each policy declares how far it lets work travel, rather than a set of
 * booleans that have to be read together to find out.
 *
 * The previous shape was `allowNetwork` + `allowCloudModels` + `preferLocal`.
 * In all five policies `allowNetwork` and `allowCloudModels` held the same
 * value, so nothing is lost by separating the two questions they were
 * conflated into — but they *are* two questions, so they get two ceilings
 * rather than one.
 *
 * Behaviour is deliberately preserved exactly, including one case that is
 * arguably wrong: `private` sets `toolCeiling: "none"`, so it blocks web
 * search even against a SearXNG on loopback that never leaves the device.
 * Under a ceiling that could now be `"local"`, and probably should be — but
 * that is a change to what a privacy mode does, and belongs to the operator
 * rather than to a refactor.
 */
export const POLICIES: Record<PolicyMode, PolicyDefinition> = {
  private: {
    id: "private",
    label: "Private",
    description: "Keep inference and tools on this machine.",
    inferenceCeiling: "local",
    toolCeiling: "none",
    preferLocal: true,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description:
      "Prefer local execution; allow automatic web search and cloud only when they add clear value.",
    inferenceCeiling: "cloud",
    toolCeiling: "cloud",
    preferLocal: true,
  },
  quality: {
    id: "quality",
    label: "Best quality",
    description: "Choose the strongest available route for each request.",
    inferenceCeiling: "cloud",
    toolCeiling: "cloud",
    preferLocal: false,
  },
  offline: {
    id: "offline",
    // `device` is the whole of it. Invariant I-4 — "offline excludes loopback
    // endpoints as well as remote endpoints" — used to be enforced by the
    // planner testing `request.policy === "offline"` by name and then checking
    // transport. Declaring the ceiling makes the exception a value.
    label: "Offline",
    description: "Disable every network operation, including local network endpoints.",
    inferenceCeiling: "device",
    toolCeiling: "none",
    preferLocal: true,
  },
  cost_controlled: {
    id: "cost_controlled",
    label: "Cost controlled",
    description: "Prefer free local routes and cap exceptional cloud use.",
    inferenceCeiling: "cloud",
    toolCeiling: "cloud",
    preferLocal: true,
    cloudBudgetUsd: 1,
  },
};

export function getPolicy(mode: PolicyMode): PolicyDefinition {
  return POLICIES[mode];
}
