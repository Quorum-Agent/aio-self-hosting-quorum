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
