import { describe, expect, it } from "vitest";

import { DemoProvider } from "./demo-provider.js";
import { ModelExecutionError } from "./model-execution-error.js";
import { Orchestrator } from "./orchestrator.js";
import type {
  ChatRequest,
  ModelDescriptor,
  ModelProvider,
  ModelStreamInput,
  OrchestrationEvent,
} from "./types.js";

function chatRequest(content: string): ChatRequest {
  return {
    conversationId: "conversation-1",
    policy: "balanced",
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

function provider(
  model: ModelDescriptor,
  stream: (input: ModelStreamInput) => AsyncIterable<string>,
): ModelProvider {
  return { model, stream };
}

async function collect(
  orchestrator: Orchestrator,
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<OrchestrationEvent[]> {
  const events: OrchestrationEvent[] = [];
  for await (const event of orchestrator.run(request, signal)) events.push(event);
  return events;
}

const generalModel: ModelDescriptor = {
  id: "local:general:test",
  label: "General",
  provider: "test",
  role: "general",
  location: "local",
  transport: "loopback",
  capabilities: ["chat", "coding", "reasoning"],
  contextWindow: 16_384,
  qualityRating: 60,
  available: true,
};

const codingModel: ModelDescriptor = {
  id: "local:coding:test",
  label: "Coding expert",
  provider: "test",
  role: "coding",
  location: "local",
  transport: "loopback",
  capabilities: ["chat", "coding"],
  specialties: ["coding"],
  contextWindow: 16_384,
  qualityRating: 50,
  available: true,
};

const cloudModel: ModelDescriptor = {
  ...generalModel,
  id: "cloud:test",
  label: "Cloud",
  location: "cloud",
  transport: "remote",
  qualityRating: 90,
};

async function* answer(content: string): AsyncIterable<string> {
  yield content;
}

async function* failBeforeOutput(): AsyncIterable<string> {
  throw new Error("provider unavailable");
}

describe("Orchestrator resilience", () => {
  it("passes the live circuit-aware model inventory to the selected provider", async () => {
    let receivedModels: ModelDescriptor[] = [];
    const observingProvider = provider(generalModel, (input) => {
      receivedModels = input.runtimeModels;
      return answer("inventory received");
    });
    const orchestrator = new Orchestrator([
      observingProvider,
      provider(codingModel, () => answer("coding response")),
      new DemoProvider(),
    ]);

    await collect(orchestrator, chatRequest("Hello."));

    expect(receivedModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: generalModel.id,
          available: true,
        }),
        expect.objectContaining({
          id: codingModel.id,
          role: "coding",
          available: true,
        }),
      ]),
    );
  });

  it("falls back to the next safe model when the first fails before output", async () => {
    const orchestrator = new Orchestrator([
      provider(codingModel, failBeforeOutput),
      provider(generalModel, () => answer("fallback response")),
      new DemoProvider(),
    ]);

    const events = await collect(
      orchestrator,
      chatRequest("Write a TypeScript function."),
    );
    const plans = events
      .filter((event) => event.type === "plan")
      .map((event) => event.plan);
    const result = events.find((event) => event.type === "result");

    expect(plans).toHaveLength(3);
    expect(plans[0]?.modelId).toBe(codingModel.id);
    expect(plans[1]).toMatchObject({
      modelId: generalModel.id,
      fallbackFromModelId: codingModel.id,
    });
    expect(result?.type === "result" && result.result.message.content).toBe(
      "fallback response",
    );
    expect(result?.type === "result" && result.result.plan.modelId).toBe(
      generalModel.id,
    );
    expect(
      result?.type === "result" && result.result.plan.attempts,
    ).toEqual([
      expect.objectContaining({
        modelId: codingModel.id,
        status: "failed",
      }),
      expect.objectContaining({
        modelId: generalModel.id,
        status: "completed",
      }),
    ]);
  });

  it("does not splice a fallback response after output has started", async () => {
    async function* partialFailure() {
      yield "partial";
      throw new Error("stream interrupted");
    }
    const orchestrator = new Orchestrator([
      provider(codingModel, partialFailure),
      provider(generalModel, () => answer("should not appear")),
    ]);

    const events = await collect(
      orchestrator,
      chatRequest("Write a TypeScript function."),
    );

    const plans = events
      .filter((event) => event.type === "plan")
      .map((event) => event.plan);
    expect(plans).toHaveLength(2);
    expect(plans.at(-1)?.attempts).toEqual([
      expect.objectContaining({
        modelId: codingModel.id,
        status: "failed",
      }),
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "error" &&
          event.message.includes("output had already begun"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "result")).toBe(false);
  });

  it("opens a circuit after repeated provider failures", async () => {
    const orchestrator = new Orchestrator([
      provider(codingModel, failBeforeOutput),
      provider(generalModel, () => answer("fallback response")),
    ]);
    const request = chatRequest("Write a TypeScript function.");

    await collect(orchestrator, request);
    await collect(orchestrator, request);
    const thirdEvents = await collect(orchestrator, request);
    const firstPlan = thirdEvents.find((event) => event.type === "plan");

    expect(firstPlan?.type === "plan" && firstPlan.plan.modelId).toBe(
      generalModel.id,
    );
    expect(
      orchestrator.models.find((model) => model.id === codingModel.id)
        ?.available,
    ).toBe(false);
  });

  it.each([
    {
      kind: "cancelled" as const,
      message: "request cancelled",
    },
    {
      kind: "request" as const,
      message: "context is too large",
    },
  ])("does not open a provider circuit for a $kind failure", async ({ kind, message }) => {
    async function* failForRequest() {
      throw new ModelExecutionError(message, kind);
    }
    const orchestrator = new Orchestrator([
      provider(codingModel, failForRequest),
      provider(generalModel, () => answer("fallback response")),
    ]);
    const request = chatRequest("Write a TypeScript function.");

    await collect(orchestrator, request);
    await collect(orchestrator, request);

    expect(
      orchestrator.models.find((model) => model.id === codingModel.id)
        ?.available,
    ).toBe(true);
  });

  it("does not open a circuit for a plain cancellation error", async () => {
    const scaffold = new DemoProvider();
    const orchestrator = new Orchestrator([scaffold]);
    const controller = new AbortController();
    controller.abort();

    await collect(orchestrator, chatRequest("Hello."), controller.signal);
    await collect(orchestrator, chatRequest("Hello."), controller.signal);

    expect(orchestrator.models[0]?.available).toBe(true);
  });

  it("retains failed cloud contact in the final local plan", async () => {
    const orchestrator = new Orchestrator([
      provider(cloudModel, failBeforeOutput),
      provider(generalModel, () => answer("local response")),
    ]);

    const events = await collect(
      orchestrator,
      {
        ...chatRequest("Hello."),
        policy: "quality",
      },
    );
    const result = events.find((event) => event.type === "result");

    expect(result?.type === "result" && result.result.plan).toMatchObject({
      route: "local",
      modelId: generalModel.id,
      attempts: [
        {
          modelId: cloudModel.id,
          route: "cloud",
          status: "failed",
          contextMayHaveBeenTransmitted: true,
          detail: "provider unavailable",
        },
        {
          modelId: generalModel.id,
          route: "local",
          status: "completed",
          contextMayHaveBeenTransmitted: false,
        },
      ],
    });
  });

  it("does not cross from a failed local route into cloud automatically", async () => {
    const orchestrator = new Orchestrator([
      provider(codingModel, failBeforeOutput),
      provider(cloudModel, () => answer("cloud response")),
      new DemoProvider(),
    ]);

    const events = await collect(
      orchestrator,
      chatRequest("Write a TypeScript function."),
    );
    const plans = events
      .filter((event) => event.type === "plan")
      .map((event) => event.plan);

    expect(plans.some((plan) => plan.modelId === cloudModel.id)).toBe(false);
    expect(plans.at(-1)).toMatchObject({
      modelId: "local:scaffold",
      degraded: true,
    });
  });
});
