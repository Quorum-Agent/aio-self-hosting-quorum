import { describe, expect, it } from "vitest";

import { DemoProvider } from "./demo-provider.js";
import { RequestCompiler } from "./request-compiler.js";
import { RoutePlanner } from "./route-planner.js";
import type { ChatRequest, ModelDescriptor } from "./types.js";

const localModel: ModelDescriptor = {
  id: "local:test",
  label: "Local test model",
  provider: "test",
  location: "local",
  transport: "loopback",
  capabilities: ["chat", "reasoning", "coding", "web", "documents"],
  contextWindow: 32_000,
  qualityRating: 60,
  available: true,
};

const cloudModel: ModelDescriptor = {
  id: "cloud:test",
  label: "Cloud test model",
  provider: "test",
  location: "cloud",
  transport: "remote",
  capabilities: ["chat", "reasoning", "web", "documents"],
  contextWindow: 128_000,
  qualityRating: 90,
  available: true,
};

function request(policy: ChatRequest["policy"], content: string): ChatRequest {
  return {
    conversationId: "conversation-1",
    policy,
    messages: [
      {
        id: "message-1",
        role: "user",
        content,
        createdAt: new Date(0).toISOString(),
      },
    ],
  };
}

describe("RoutePlanner", () => {
  const compiler = new RequestCompiler();
  const planner = new RoutePlanner();

  it("keeps private requests local", () => {
    const plan = planner.plan(
      compiler.compile(request("private", "Research the latest release")),
      [localModel, cloudModel],
    );

    expect(plan.route).toBe("local");
    expect(plan.modelId).toBe(localModel.id);
    expect(plan.cloudDisclosure).toBeUndefined();
  });

  it("allows quality mode to prefer the stronger cloud context", () => {
    const plan = planner.plan(
      compiler.compile(request("quality", "Research the latest release")),
      [localModel, cloudModel],
    );

    expect(plan.route).toBe("cloud");
    expect(plan.cloudDisclosure).toBeTruthy();
  });

  it("does not send explicitly sensitive content to cloud", () => {
    const plan = planner.plan(
      compiler.compile(request("quality", "Summarize this confidential document")),
      [localModel, cloudModel],
    );

    expect(plan.route).toBe("local");
  });

  it("fails closed when sensitive content has no safe local route", () => {
    expect(() =>
      planner.plan(
        compiler.compile(request("quality", "Summarize this confidential document")),
        [cloudModel],
      ),
    ).toThrow("No available model");
  });

  it("does not forward prior web-grounded output to a cloud model", () => {
    const compiled = compiler.compile({
      ...request("quality", "Compare that with another approach."),
      messages: [
        {
          id: "assistant-web",
          role: "assistant",
          content: "Grounded in an earlier web search.",
          provenance: "web_grounded",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "message-2",
          role: "user",
          content: "Compare that with another approach.",
          createdAt: new Date(1).toISOString(),
        },
      ],
    });
    const plan = planner.plan(compiled, [localModel, cloudModel]);

    expect(plan.route).toBe("local");
    expect(plan.safety?.containsWebGroundedData).toBe(true);
  });

  it("only uses an in-process provider in offline mode", () => {
    const inProcessModel: ModelDescriptor = {
      ...localModel,
      id: "local:in-process",
      transport: "in_process",
      qualityRating: 1,
    };
    const plan = planner.plan(
      compiler.compile(request("offline", "Help me think through an idea")),
      [localModel, inProcessModel],
    );

    expect(plan.modelId).toBe(inProcessModel.id);
  });

  it("routes a capabilities question to a real local model instead of the scaffold", () => {
    const scaffoldModel = new DemoProvider().model;
    const plan = planner.plan(
      compiler.compile(
        request("balanced", "What are your current capabilities?"),
      ),
      [localModel, scaffoldModel],
    );

    expect(scaffoldModel.capabilities).toEqual(["chat"]);
    expect(plan.modelId).toBe(localModel.id);
  });

  it.each([
    {
      prompt: "Write a TypeScript function that adds two numbers.",
      capability: "coding" as const,
      modelId: "local:code-expert",
    },
    {
      prompt: "Solve this logic proof step by step.",
      capability: "reasoning" as const,
      modelId: "local:reasoning-expert",
    },
  ])("prefers the $capability specialist", ({ prompt, capability, modelId }) => {
    const expert: ModelDescriptor = {
      id: modelId,
      label: `${capability} expert`,
      provider: "test",
      location: "local",
      transport: "loopback",
      capabilities: ["chat", capability],
      specialties: [capability],
      contextWindow: 32_000,
      qualityRating: 50,
      available: true,
    };
    const plan = planner.plan(
      compiler.compile(request("balanced", prompt)),
      [localModel, expert],
    );

    expect(plan.modelId).toBe(expert.id);
    expect(plan.rationale).toContain(`${capability} specialist`);
  });

  it("does not route ordinary conversation to a specialist", () => {
    const codingExpert: ModelDescriptor = {
      ...localModel,
      id: "local:code-expert",
      label: "Code expert",
      specialties: ["coding"],
      qualityRating: 50,
    };
    const plan = planner.plan(
      compiler.compile(request("balanced", "Help me think through an idea.")),
      [localModel, codingExpert],
    );

    expect(plan.modelId).toBe(localModel.id);
  });

  it("does not let duplicate specialty tags inflate a model score", () => {
    const singleSpecialty: ModelDescriptor = {
      ...localModel,
      id: "local:single-specialty",
      qualityRating: 50,
      specialties: ["coding"],
    };
    const duplicateSpecialty: ModelDescriptor = {
      ...singleSpecialty,
      id: "local:duplicate-specialty",
      qualityRating: 49,
      specialties: ["coding", "coding", "coding"],
    };

    const plan = planner.plan(
      compiler.compile(
        request("balanced", "Write a TypeScript function for this."),
      ),
      [singleSpecialty, duplicateSpecialty],
    );

    expect(plan.modelId).toBe(singleSpecialty.id);
  });

  it("keeps best-quality mode anchored to quality instead of specialty tags", () => {
    const specialist: ModelDescriptor = {
      ...localModel,
      id: "local:low-quality-specialist",
      qualityRating: 50,
      specialties: ["reasoning"],
    };
    const stronger: ModelDescriptor = {
      ...cloudModel,
      id: "cloud:stronger",
      capabilities: ["chat", "reasoning"],
      qualityRating: 79,
      specialties: [],
    };

    const plan = planner.plan(
      compiler.compile(request("quality", "Solve this probability problem.")),
      [specialist, stronger],
    );

    expect(plan.modelId).toBe(stronger.id);
  });

  it("lets a matching specialist overcome a small static quality gap", () => {
    const codingExpert: ModelDescriptor = {
      ...localModel,
      id: "local:coding:qwen2.5-coder",
      label: "Coding expert",
      capabilities: ["chat", "coding"],
      specialties: ["coding"],
      qualityRating: 50,
    };

    const plan = planner.plan(
      compiler.compile(
        request(
          "quality",
          "Create a SQL PIVOT query whose columns are dynamic.",
        ),
      ),
      [localModel, codingExpert],
    );

    expect(plan.modelId).toBe(codingExpert.id);
    expect(plan.rationale).toContain("coding specialist");
  });

  it("routes architecture trade-off analysis to the reasoning expert", () => {
    const reasoningExpert: ModelDescriptor = {
      ...localModel,
      id: "local:reasoning:qwen3.5",
      label: "Reasoning expert",
      capabilities: ["chat", "reasoning"],
      specialties: ["reasoning"],
      qualityRating: 55,
    };

    const plan = planner.plan(
      compiler.compile(
        request(
          "quality",
          "Compare a modular architecture with a monolith for a local-first assistant, then recommend a practical starting point.",
        ),
      ),
      [localModel, reasoningExpert],
    );

    expect(plan.modelId).toBe(reasoningExpert.id);
    expect(plan.rationale).toContain("reasoning specialist");
  });

  it("uses the in-process scaffold transparently when no model has the capability", () => {
    const scaffold = new DemoProvider().model;
    const plan = planner.plan(
      compiler.compile(
        request("offline", "Solve this probability problem."),
      ),
      [scaffold],
    );

    expect(plan).toMatchObject({
      modelId: scaffold.id,
      degraded: true,
    });
    expect(plan.rationale).toContain("no model with every required capability");
  });

  it("marks ordinary scaffold chat as degraded too", () => {
    const scaffold = new DemoProvider().model;
    const plan = planner.plan(
      compiler.compile(request("balanced", "Hello there.")),
      [scaffold],
    );

    expect(plan).toMatchObject({
      modelId: scaffold.id,
      degraded: true,
    });
    expect(plan.rationale).toContain("local scaffold");
  });
});

describe("RoutePlanner in relay mode", () => {
  const compiler = new RequestCompiler();
  const relayPlanner = new RoutePlanner("relay");

  const hubModel: ModelDescriptor = {
    id: "local:general:hub",
    label: "Hub model",
    provider: "test",
    role: "general",
    location: "local",
    transport: "loopback",
    capabilities: ["chat", "reasoning", "coding", "documents"],
    contextWindow: 16_384,
    qualityRating: 55,
    available: true,
  };

  const codingSpoke: ModelDescriptor = {
    id: "local:coding:spoke",
    label: "Coding spoke",
    provider: "test",
    role: "coding",
    location: "local",
    transport: "loopback",
    capabilities: ["chat", "coding"],
    specialties: ["coding"],
    contextWindow: 16_384,
    qualityRating: 70,
    available: true,
  };

  function codingPlan(models: ModelDescriptor[]) {
    return relayPlanner.plan(
      compiler.compile(request("balanced", "Write a TypeScript function.")),
      models,
    );
  }

  it("drafts with the spoke and gives the hub the final word", () => {
    const plan = codingPlan([hubModel, codingSpoke]);
    const modelSteps = plan.steps.filter(
      (step) => step.kind === "model" || step.kind === "synthesis",
    );

    expect(modelSteps.map((step) => step.modelId)).toEqual([
      codingSpoke.id,
      hubModel.id,
    ]);
    // The synthesis step must stay last: the orchestrator re-splices
    // retrieval steps around the leading device steps on fallback.
    expect(plan.steps.at(-1)?.kind).toBe("synthesis");
    expect(plan.modelId).toBe(hubModel.id);
    expect(plan.spokeModelId).toBe(codingSpoke.id);
  });

  it("never plans a synthesis step that does no work", () => {
    for (const plan of [
      codingPlan([hubModel, codingSpoke]),
      codingPlan([hubModel]),
      new RoutePlanner().plan(
        compiler.compile(request("balanced", "Write a TypeScript function.")),
        [hubModel, codingSpoke],
      ),
    ]) {
      for (const step of plan.steps) {
        if (step.kind === "synthesis") expect(step.modelId).toBeDefined();
      }
    }
  });

  it("degrades to a single model when the spoke is also the hub", () => {
    const plan = codingPlan([hubModel]);

    expect(plan.steps.some((step) => step.kind === "synthesis")).toBe(false);
    expect(plan.modelId).toBe(hubModel.id);
    expect(plan.spokeModelId).toBeUndefined();
  });

  it("degrades when two roles point at the same underlying model", () => {
    // Same provider and label, different configured id: relaying this to
    // itself would cost a second inference for nothing.
    const plan = codingPlan([
      hubModel,
      { ...codingSpoke, provider: hubModel.provider, label: hubModel.label },
    ]);

    expect(plan.steps.some((step) => step.kind === "synthesis")).toBe(false);
  });

  it("discloses cloud egress when only the spoke is remote", () => {
    // Needs a policy that can prefer a remote model; balanced prefers local,
    // so the cloud model would never be drafted with in the first place.
    const plan = relayPlanner.plan(
      compiler.compile(request("quality", "Write a TypeScript function.")),
      [
        hubModel,
        {
          ...codingSpoke,
          id: "cloud:spoke",
          location: "cloud",
          transport: "remote",
          qualityRating: 95,
        },
      ],
    );

    expect(plan.spokeModelId).toBe("cloud:spoke");
    expect(plan.modelId).toBe(hubModel.id);
    // The hub is local, but context still left the device via the spoke.
    expect(plan.route).toBe("cloud");
    expect(plan.cloudDisclosure).toBeDefined();
  });
});
