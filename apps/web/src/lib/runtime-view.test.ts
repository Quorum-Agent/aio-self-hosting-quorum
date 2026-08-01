import { describe, expect, it } from "vitest";

import type { LocalRuntimeStatus, ModelDescriptor } from "@quorum/core";

import {
  describeModelAttempts,
  describeRuntimeStatus,
  describeCloudUsage,
  selectablePolicies,
  supportsCapability,
} from "./runtime-view";

function status(
  state: LocalRuntimeStatus["state"],
  endpointConnected: boolean,
  availableRoles: Array<"general" | "coding" | "reasoning">,
): LocalRuntimeStatus {
  return {
    state,
    endpointConnected,
    roles: (["general", "coding", "reasoning"] as const).map((role) => ({
      role,
      configuredModel: role,
      required: role === "general",
      available: availableRoles.includes(role),
    })),
  };
}

const chatModel: ModelDescriptor = {
  id: "local:scaffold",
  label: "Scaffold",
  provider: "quorum",
  location: "local",
  transport: "in_process",
  capabilities: ["chat"],
  contextWindow: 8_000,
  qualityRating: 10,
  available: true,
};

const offlinePolicy = {
  id: "offline" as const,
  label: "Offline",
  description: "No network",
  inferenceCeiling: "device" as const,
  toolCeiling: "none" as const,
  preferLocal: true,
};

const requestAnalysis = {
  source: "heuristic" as const,
  intent: "conversation" as const,
  confidence: 0.5,
  taskSummary: "Test request",
};

describe("runtime view", () => {
  it("does not call optional experts a ready runtime", () => {
    expect(
      describeRuntimeStatus(
        status("degraded", true, ["coding", "reasoning"]),
      ),
    ).toEqual({
      state: "degraded",
      title: "Local runtime degraded",
      detail: "General model missing; coding, reasoning available",
    });
  });

  it("distinguishes an unavailable endpoint", () => {
    expect(describeRuntimeStatus(status("unavailable", false, []))).toEqual({
      state: "unavailable",
      title: "Local runtime unavailable",
      detail: "Local model endpoint is not connected",
    });
  });

  it("moves a failed runtime fetch out of the loading state", () => {
    expect(describeRuntimeStatus(undefined, true)).toEqual({
      state: "unavailable",
      title: "Quorum API unavailable",
      detail: "Could not load runtime status",
    });
  });

  it("describes discovery without claiming that models are already warm", () => {
    expect(
      describeRuntimeStatus(
        status("ready", true, ["general", "coding", "reasoning"]),
      ),
    ).toEqual({
      state: "ready",
      title: "Local roles discovered",
      detail: "general, coding, reasoning configured",
    });
  });

  it("surfaces configured web search without adding a nonfunctional control", () => {
    expect(
      describeRuntimeStatus(
        status("ready", true, ["general", "coding", "reasoning"]),
        false,
        undefined,
        {
          id: "web-search:searxng",
          label: "SearXNG",
          capabilities: ["web"],
          location: "local",
          available: true,
          contextMayLeaveDevice: true,
        },
      ).detail,
    ).toBe("general, coding, reasoning, web search configured");
  });

  it("keeps web-search availability visible when optional local roles are degraded", () => {
    expect(
      describeRuntimeStatus(
        status("degraded", true, ["general", "coding"]),
        false,
        undefined,
        {
          id: "web-search:searxng",
          label: "SearXNG",
          capabilities: ["web"],
          location: "local",
          available: true,
          contextMayLeaveDevice: true,
        },
      ).detail,
    ).toContain("web search configured");
  });

  it("shows the model currently warming before claiming readiness", () => {
    expect(
      describeRuntimeStatus(
        status("ready", true, ["general", "coding", "reasoning"]),
        false,
        {
          state: "warming",
          models: [
            {
              model: "qwen3:4b",
              role: "general",
              status: "warming",
            },
          ],
        },
      ),
    ).toEqual({
      state: "loading",
      title: "Warming local models",
      detail: "Loading qwen3:4b for general work",
    });
  });

  it("only exposes capabilities backed by an available model", () => {
    expect(supportsCapability([chatModel], "chat")).toBe(true);
    expect(supportsCapability([chatModel], "coding")).toBe(false);
    expect(supportsCapability([chatModel], "vision")).toBe(false);
  });

  it("does not expose a loopback-backed starter in offline mode", () => {
    const codingModel: ModelDescriptor = {
      ...chatModel,
      id: "local:coding",
      transport: "loopback",
      capabilities: ["chat", "coding"],
    };

    expect(
      supportsCapability([codingModel], "coding", offlinePolicy),
    ).toBe(false);
  });

  // The test above cannot distinguish "offline correctly excludes loopback"
  // from "offline excludes everything" — its fixture cannot reach the wrong
  // answer, so it stayed green through a regression that made offline show no
  // starter prompts at all. This is the other half: offline must still admit
  // the in-process model it exists to be served by.
  it("still exposes the in-process model offline mode runs on", () => {
    const inProcessModel: ModelDescriptor = {
      ...chatModel,
      id: "local:scaffold",
      transport: "in_process",
      capabilities: ["chat"],
    };

    expect(
      supportsCapability([inProcessModel], "chat", offlinePolicy),
    ).toBe(true);
  });

  it("can require a local route instead of silently exposing a cloud-only starter", () => {
    const cloudCodingModel: ModelDescriptor = {
      ...chatModel,
      id: "cloud:coding",
      location: "cloud",
      transport: "remote",
      capabilities: ["chat", "coding"],
    };

    expect(
      supportsCapability(
        [cloudCodingModel],
        "coding",
        {
          ...offlinePolicy,
          id: "balanced",
          inferenceCeiling: "cloud" as const,
          toolCeiling: "cloud" as const,
        },
        "local",
      ),
    ).toBe(false);
  });

  it("does not expose cost control before a usage ledger enforces its cap", () => {
    expect(
      selectablePolicies([
        offlinePolicy,
        {
          ...offlinePolicy,
          id: "cost_controlled",
          label: "Cost controlled",
          cloudBudgetUsd: 1,
        },
      ]).map((policy) => policy.id),
    ).toEqual(["offline"]);
  });

  it("does not erase failed cloud contact after a local fallback", () => {
    const cloudModel: ModelDescriptor = {
      ...chatModel,
      id: "cloud:test",
      label: "Cloud test",
      location: "cloud",
      transport: "remote",
    };
    const usage = describeCloudUsage(
      {
        id: "plan",
        requestId: "request",
        policy: "quality",
        analysis: requestAnalysis,
        route: "local",
        modelId: chatModel.id,
        verbosity: "standard",
        rationale: "Cloud failed; local answered.",
        steps: [],
        attempts: [
          {
            modelId: cloudModel.id,
            route: "cloud",
            status: "failed",
            contextMayHaveBeenTransmitted: true,
          },
          {
            modelId: chatModel.id,
            route: "local",
            status: "completed",
            contextMayHaveBeenTransmitted: false,
          },
        ],
      },
      [chatModel, cloudModel],
    );

    expect(usage).toEqual({
      activity: true,
      selected: false,
      contacted: true,
      // The plan's own tier, not "Cloud". A local fallback after failed cloud
      // contact IS a local route; the diagram must say so while the attempt
      // ledger still records that the earlier contact happened.
      routeLabel: "Local",
      // Nothing is selected off-device — the answer came from a local model —
      // but a cloud attempt did happen and is still in the ledger, so the
      // generic heading is right here. Naming a tier would credit a route that
      // did not produce the answer.
      headingLabel: "Off-device activity",
      text: "Contacted Cloud test; final route local",
    });
  });

  it("discloses web-search transmission when the answering model stayed local", () => {
    const usage = describeCloudUsage(
      {
        id: "plan",
        requestId: "request",
        policy: "balanced",
        analysis: requestAnalysis,
        route: "local",
        modelId: chatModel.id,
        verbosity: "standard",
        rationale: "Search first, answer locally.",
        steps: [],
        webSearch: {
          provider: "SearXNG",
          query: "latest release",
          contextMayHaveLeftDevice: true,
          sources: [
            {
              title: "Release",
              url: "https://example.com/release",
            },
          ],
        },
      },
      [chatModel],
    );

    expect(usage).toEqual({
      activity: true,
      selected: false,
      contacted: true,
      routeLabel: "Local",
      // The model stayed local; only the search left. Calling this "Local
      // network activity" would name a tier nothing used, and calling it
      // "Cloud usage" is what it used to say.
      headingLabel: "Web search",
      text: "Web search via SearXNG; planned model route local",
    });
  });

  it("preserves the attempted route while a fallback model is selected", () => {
    const cloudModel: ModelDescriptor = {
      ...chatModel,
      id: "cloud:test",
      label: "Cloud test",
      location: "cloud",
      transport: "remote",
    };
    const attempts = describeModelAttempts(
      {
        id: "plan",
        requestId: "request",
        policy: "balanced",
        analysis: requestAnalysis,
        route: "local",
        modelId: chatModel.id,
        verbosity: "detailed",
        rationale: "Cloud failed; local selected.",
        steps: [],
        attempts: [
          {
            modelId: cloudModel.id,
            route: "cloud",
            status: "failed",
            detail: "Cloud endpoint unavailable",
            contextMayHaveBeenTransmitted: true,
          },
        ],
      },
      [chatModel, cloudModel],
    );

    expect(attempts).toEqual({
      swaps: 1,
      attempts: [
        {
          modelId: cloudModel.id,
          label: "Cloud test",
          route: "cloud",
          status: "failed",
          detail: "Cloud endpoint unavailable",
          contextMayHaveBeenTransmitted: true,
        },
        {
          modelId: chatModel.id,
          label: "Scaffold",
          route: "local",
          status: "selected",
          contextMayHaveBeenTransmitted: false,
        },
      ],
    });
  });

  it("reports no swap for a single completed model attempt", () => {
    const attempts = describeModelAttempts(
      {
        id: "plan",
        requestId: "request",
        policy: "offline",
        analysis: requestAnalysis,
        route: "local",
        modelId: chatModel.id,
        verbosity: "detailed",
        rationale: "Local model completed the request.",
        steps: [],
        attempts: [
          {
            modelId: chatModel.id,
            route: "local",
            status: "completed",
            contextMayHaveBeenTransmitted: false,
          },
        ],
      },
      [chatModel],
    );

    expect(attempts.swaps).toBe(0);
    expect(attempts.attempts).toHaveLength(1);
    expect(attempts.attempts[0]?.status).toBe("completed");
  });

  it("does not mislabel a retry of the same model as a swap", () => {
    const attempts = describeModelAttempts(
      {
        id: "plan",
        requestId: "request",
        policy: "balanced",
        analysis: requestAnalysis,
        route: "local",
        modelId: chatModel.id,
        verbosity: "detailed",
        rationale: "The local model completed after a retry.",
        steps: [],
        attempts: [
          {
            modelId: chatModel.id,
            route: "local",
            status: "failed",
            contextMayHaveBeenTransmitted: false,
          },
          {
            modelId: chatModel.id,
            route: "local",
            status: "completed",
            contextMayHaveBeenTransmitted: false,
          },
        ],
      },
      [chatModel],
    );

    expect(attempts.swaps).toBe(0);
  });

  it("counts a relay handoff as a pipeline stage, not a fallback swap", () => {
    const hubModel: ModelDescriptor = {
      ...chatModel,
      id: "local:general:hub",
      label: "Hub",
    };
    const attempts = describeModelAttempts(
      {
        id: "plan",
        requestId: "request",
        policy: "balanced",
        analysis: requestAnalysis,
        route: "local",
        modelId: hubModel.id,
        spokeModelId: chatModel.id,
        verbosity: "standard",
        rationale: "Spoke drafted; hub synthesized.",
        steps: [],
        attempts: [
          {
            modelId: chatModel.id,
            stage: "draft",
            route: "local",
            status: "completed",
            contextMayHaveBeenTransmitted: false,
          },
          {
            modelId: hubModel.id,
            stage: "synthesis",
            route: "local",
            status: "completed",
            contextMayHaveBeenTransmitted: false,
          },
        ],
      },
      [chatModel, hubModel],
    );

    // Two different models ran, but neither replaced a failure.
    expect(attempts.swaps).toBe(0);
    expect(attempts.attempts.map((attempt) => attempt.stage)).toEqual([
      "draft",
      "synthesis",
    ]);
  });
});
