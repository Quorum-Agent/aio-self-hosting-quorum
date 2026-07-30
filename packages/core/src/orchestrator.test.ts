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
  WebSearchProvider,
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
  it("retrieves current sources before using a local reasoning model", async () => {
    let receivedInput: ModelStreamInput | undefined;
    let cloudCalled = false;
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:test",
        label: "Test Search",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search(query) {
        return {
          query,
          results: [
            {
              title: "Current source",
              url: "https://example.com/current",
              snippet: "The current release is 2.0.",
            },
          ],
        };
      },
    };
    const orchestrator = new Orchestrator(
      [
        provider(generalModel, (input) => {
          receivedInput = input;
          return answer("The current release is 2.0 [1].");
        }),
        provider(cloudModel, () => {
          cloudCalled = true;
          return answer("Cloud must not receive retrieved data.");
        }),
      ],
      undefined,
      undefined,
      undefined,
      webSearch,
    );

    const events = await collect(
      orchestrator,
      {
        ...chatRequest("Research the latest Quorum release."),
        policy: "quality",
      },
    );
    const result = events.find((event) => event.type === "result");
    const finalPlan =
      result?.type === "result" ? result.result.plan : undefined;

    expect(receivedInput?.runtimeTools).toEqual([webSearch.tool]);
    expect(cloudCalled).toBe(false);
    expect(finalPlan?.route).toBe("local");
    expect(receivedInput?.messages.at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringContaining(
        '"url":"https://example.com/current"',
      ),
    });
    expect(finalPlan?.webSearch).toEqual({
      provider: "Test Search",
      query: "Research the latest Quorum release.",
      contextMayHaveLeftDevice: true,
      sources: [
        {
          title: "Current source",
          url: "https://example.com/current",
        },
      ],
    });
    expect(finalPlan?.steps.some((step) => step.kind === "retrieval")).toBe(
      true,
    );
    const runningRetrieval = events.find(
      (event) =>
        event.type === "trace" &&
        event.trace.kind === "retrieval" &&
        event.trace.status === "running",
    );
    const completedRetrieval = events.find(
      (event) =>
        event.type === "trace" &&
        event.trace.kind === "retrieval" &&
        event.trace.status === "completed",
    );
    expect(
      completedRetrieval?.type === "trace" &&
        completedRetrieval.trace.startedAt,
    ).toBe(
      runningRetrieval?.type === "trace" && runningRetrieval.trace.startedAt,
    );
    expect(
      result?.type === "result" && result.result.message.content,
    ).toContain(
      "Sources\n[1] Current source — https://example.com/current",
    );
  });

  it("blocks network search under Private mode before contacting a provider", async () => {
    let searchCalls = 0;
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:test",
        label: "Test Search",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search() {
        searchCalls += 1;
        return { query: "unused", results: [] };
      },
    };
    const orchestrator = new Orchestrator(
      [provider(generalModel, () => answer("must not run"))],
      undefined,
      undefined,
      undefined,
      webSearch,
    );

    const events = await collect(orchestrator, {
      ...chatRequest("Research the latest Quorum release."),
      policy: "private",
    });

    expect(searchCalls).toBe(0);
    expect(events).toContainEqual({
      type: "error",
      message:
        "Private mode blocks web search. Choose Balanced or Best quality to use current web sources.",
      recoverable: true,
    });
    expect(events.some((event) => event.type === "plan")).toBe(false);
  });

  it("fails quickly and clearly when current sources are required but search is unconfigured", async () => {
    const orchestrator = new Orchestrator([
      provider(generalModel, () => answer("must not run")),
    ]);

    const events = await collect(
      orchestrator,
      chatRequest("Research the latest Quorum release."),
    );

    expect(events).toContainEqual({
      type: "error",
      message:
        "This request needs current web sources, but no web-search provider is configured.",
      recoverable: true,
    });
    expect(events.some((event) => event.type === "plan")).toBe(false);
  });

  it("blocks sensitive search text before it can leave the device", async () => {
    let searchCalls = 0;
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:test",
        label: "Test Search",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search() {
        searchCalls += 1;
        return { query: "unused", results: [] };
      },
    };
    const orchestrator = new Orchestrator(
      [provider(generalModel, () => answer("must not run"))],
      undefined,
      undefined,
      undefined,
      webSearch,
    );

    const events = await collect(
      orchestrator,
      chatRequest(
        "Search the web for the latest breach involving SSN 123-45-6789.",
      ),
    );

    expect(searchCalls).toBe(0);
    expect(events).toContainEqual({
      type: "error",
      message:
        "Web search was blocked because the request appears to contain sensitive data.",
      recoverable: true,
    });
  });

  it("uses the local analyzer's resolved task summary for a contextual search", async () => {
    let searchedQuery = "";
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:test",
        label: "Test Search",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search(query) {
        searchedQuery = query;
        return {
          query,
          results: [
            {
              title: "PostgreSQL release",
              url: "https://example.com/postgresql",
              snippet: "PostgreSQL has a current release.",
            },
          ],
        };
      },
    };
    const orchestrator = new Orchestrator(
      [provider(generalModel, () => answer("Current answer [1]."))],
      undefined,
      undefined,
      {
        id: "local:classifier:test",
        label: "Prompt expert",
        async analyze() {
          return {
            intent: "research",
            confidence: 0.96,
            taskSummary: "Find the latest PostgreSQL release.",
          };
        },
      },
      webSearch,
    );

    await collect(
      orchestrator,
      {
        ...chatRequest("What's the latest?"),
        messages: [
          {
            id: "prior-user",
            role: "user",
            content: "Search the web for PostgreSQL releases.",
            createdAt: new Date(0).toISOString(),
          },
          {
            id: "current-user",
            role: "user",
            content: "What's the latest?",
            createdAt: new Date(1).toISOString(),
          },
        ],
      },
    );

    expect(searchedQuery).toBe("Find the latest PostgreSQL release.");
  });

  it("uses prior user context for a search when the analyzer is unavailable", async () => {
    let searchedQuery = "";
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:test",
        label: "Test Search",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search(query) {
        searchedQuery = query;
        return {
          query,
          results: [
            {
              title: "PostgreSQL release",
              url: "https://example.com/postgresql",
              snippet: "PostgreSQL has a current release.",
            },
          ],
        };
      },
    };
    const orchestrator = new Orchestrator(
      [provider(generalModel, () => answer("Current answer [1]."))],
      undefined,
      undefined,
      undefined,
      webSearch,
    );

    await collect(orchestrator, {
      ...chatRequest("What's the latest?"),
      messages: [
        {
          id: "prior-user",
          role: "user",
          content: "Search the web for PostgreSQL releases.",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "current-user",
          role: "user",
          content: "What's the latest?",
          createdAt: new Date(1).toISOString(),
        },
      ],
    });

    expect(searchedQuery).toBe(
      "Search the web for PostgreSQL releases. Follow-up: What's the latest?",
    );
  });

  it("does not egress a query when no capable post-search model exists", async () => {
    let searchCalls = 0;
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:test",
        label: "Test Search",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search() {
        searchCalls += 1;
        return { query: "unused", results: [] };
      },
    };
    const orchestrator = new Orchestrator(
      [new DemoProvider()],
      undefined,
      undefined,
      undefined,
      webSearch,
    );

    const events = await collect(
      orchestrator,
      chatRequest("Research the latest Quorum release."),
    );

    expect(searchCalls).toBe(0);
    expect(events).toContainEqual({
      type: "error",
      message:
        "Web search was not started because no capable local model is available to process the results privately.",
      recoverable: true,
    });
  });

  it("drops sensitive search results and retains the failed egress plan", async () => {
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:test",
        label: "Test Search",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search(query) {
        return {
          query,
          results: [
            {
              title: "Leaked credential",
              url: "https://example.com/leak",
              snippet: "Use API key sk-exampleSecret12345.",
            },
          ],
        };
      },
    };
    const orchestrator = new Orchestrator(
      [provider(generalModel, () => answer("must not run"))],
      undefined,
      undefined,
      undefined,
      webSearch,
    );

    const events = await collect(
      orchestrator,
      chatRequest("Research the latest Quorum release."),
    );
    const error = events.find((event) => event.type === "error");

    expect(error).toMatchObject({
      type: "error",
      message: "Web search returned no usable, non-sensitive sources.",
      plan: {
        route: "local",
        webSearch: {
          provider: "Test Search",
          contextMayHaveLeftDevice: true,
          sources: [],
        },
      },
    });
    expect(events.some((event) => event.type === "result")).toBe(false);
  });

  it("uses the local prompt analyzer before selecting a specialist", async () => {
    const orchestrator = new Orchestrator(
      [
        provider(generalModel, () => answer("general response")),
        provider(codingModel, () => answer("coding response")),
      ],
      undefined,
      undefined,
      {
        id: "local:classifier:test",
        label: "Tiny classifier",
        async analyze() {
          return {
            intent: "coding",
            confidence: 0.93,
            taskSummary: "Continue the current coding task.",
          };
        },
      },
    );

    const events = await collect(
      orchestrator,
      chatRequest("Can you help me with this?"),
    );
    const firstPlan = events.find((event) => event.type === "plan");
    const analysisTrace = events.find(
      (event) =>
        event.type === "trace" &&
        event.trace.kind === "classification" &&
        event.trace.status === "completed",
    );

    expect(firstPlan?.type === "plan" && firstPlan.plan).toMatchObject({
      modelId: codingModel.id,
      analysis: {
        source: "local_model",
        intent: "coding",
        analyzer: {
          modelId: "local:classifier:test",
        },
      },
    });
    expect(
      analysisTrace?.type === "trace" && analysisTrace.trace.detail,
    ).toContain("coding · 93% confidence");
  });

  it("discloses a tiny-model disagreement while preserving explicit coding intent", async () => {
    const orchestrator = new Orchestrator(
      [
        provider(generalModel, () => answer("general response")),
        provider(codingModel, () => answer("coding response")),
      ],
      undefined,
      undefined,
      {
        id: "local:classifier:test",
        label: "Tiny classifier",
        async analyze() {
          return {
            intent: "conversation",
            confidence: 1,
            taskSummary: "Discuss a table.",
          };
        },
      },
    );

    const events = await collect(orchestrator, {
      ...chatRequest("Create a SQL PIVOT query with dynamic columns."),
      policy: "quality",
    });
    const firstPlan = events.find((event) => event.type === "plan");
    const analysisTrace = events.find(
      (event) =>
        event.type === "trace" &&
        event.trace.kind === "classification" &&
        event.trace.status === "completed",
    );

    expect(firstPlan?.type === "plan" && firstPlan.plan).toMatchObject({
      modelId: codingModel.id,
      analysis: {
        source: "hybrid",
        intent: "coding",
        analyzer: { intent: "conversation" },
      },
    });
    expect(
      analysisTrace?.type === "trace" && analysisTrace.trace.detail,
    ).toBe("conversation proposed · deterministic coding retained");
  });

  it("keeps chained elliptical SQL follow-ups on the coding expert without swaps", async () => {
    const orchestrator = new Orchestrator(
      [
        provider(generalModel, () => answer("general response")),
        provider(codingModel, () => answer("coding response")),
      ],
      undefined,
      undefined,
      {
        id: "local:classifier:test",
        label: "Tiny classifier",
        async analyze() {
          return {
            intent: "conversation",
            confidence: 1,
            taskSummary: "Discuss alternative approaches.",
          };
        },
      },
    );

    const events = await collect(orchestrator, {
      conversationId: "conversation-1",
      policy: "quality",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Create a SQL PIVOT query with dynamic columns.",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "message-2",
          role: "assistant",
          content: "Use conditional aggregation or dynamic SQL.",
          createdAt: new Date(1).toISOString(),
        },
        {
          id: "message-3",
          role: "user",
          content: "Are there any better ways?",
          createdAt: new Date(2).toISOString(),
        },
        {
          id: "message-4",
          role: "assistant",
          content: "Conditional aggregation is another option.",
          createdAt: new Date(3).toISOString(),
        },
        {
          id: "message-5",
          role: "user",
          content: "What about for ORACLE?",
          createdAt: new Date(4).toISOString(),
        },
      ],
    });
    const plans = events
      .filter((event) => event.type === "plan")
      .map((event) => event.plan);
    const result = events.find((event) => event.type === "result");

    expect(plans).toHaveLength(2);
    expect(plans.every((plan) => plan.modelId === codingModel.id)).toBe(true);
    expect(plans.every((plan) => !plan.fallbackFromModelId)).toBe(true);
    expect(plans[0]).toMatchObject({
      modelId: codingModel.id,
      analysis: {
        source: "hybrid",
        intent: "coding",
        analyzer: { intent: "conversation" },
      },
    });
    expect(
      result?.type === "result" && result.result.plan.attempts,
    ).toEqual([
      expect.objectContaining({
        modelId: codingModel.id,
        status: "completed",
      }),
    ]);
  });

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
    {
      kind: "unsafe_output" as const,
      message: "model omitted the public-answer envelope",
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

  it("counts only provider failures across an intervening unsafe output", async () => {
    const failureKinds = ["provider", "unsafe_output", "provider"] as const;
    let run = 0;
    async function* failInSequence() {
      const kind = failureKinds[run++] ?? "provider";
      throw new ModelExecutionError(`${kind} failure`, kind);
    }
    const orchestrator = new Orchestrator([
      provider(codingModel, failInSequence),
      provider(generalModel, () => answer("fallback response")),
    ]);
    const request = chatRequest("Write a TypeScript function.");

    await collect(orchestrator, request);
    expect(
      orchestrator.models.find((model) => model.id === codingModel.id)
        ?.available,
    ).toBe(true);
    await collect(orchestrator, request);
    expect(
      orchestrator.models.find((model) => model.id === codingModel.id)
        ?.available,
    ).toBe(true);
    await collect(orchestrator, request);
    expect(
      orchestrator.models.find((model) => model.id === codingModel.id)
        ?.available,
    ).toBe(false);
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
