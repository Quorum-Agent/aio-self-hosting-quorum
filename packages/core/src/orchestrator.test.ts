import { describe, expect, it } from "vitest";

import { DemoProvider } from "./demo-provider.js";
import { ModelExecutionError } from "./model-execution-error.js";
import { Orchestrator } from "./orchestrator.js";
import { RequestCompiler } from "./request-compiler.js";
import { RoutePlanner } from "./route-planner.js";
import { WebSearchExecutionError } from "./web-search-execution-error.js";
import type {
  ChatMessage,
  ChatRequest,
  TaskPlan,
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
    ).toBe("The current release is 2.0 [1].");
    expect(
      result?.type === "result" && result.result.message.provenance,
    ).toBe("web_grounded");
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
        "Web search was blocked by the privacy guard. Detected categories: government_id. Remove that data or keep the request local.",
      recoverable: true,
    });
  });

  it("never uses the local analyzer's free-text summary as an outbound query", async () => {
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

    expect(searchedQuery).toBe("What's the latest?");
  });

  it("strips bidirectional controls from source titles before display", async () => {
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
              title: "Trusted\u200B\u202Egpj.exe\u2066",
              url: "https://example.com/current",
              snippet: "Current information.",
            },
          ],
        };
      },
    };
    const orchestrator = new Orchestrator(
      [provider(generalModel, () => answer("Grounded answer [1]."))],
      undefined,
      undefined,
      undefined,
      webSearch,
    );

    const events = await collect(
      orchestrator,
      chatRequest("Research the latest Quorum release."),
    );
    const result = events.find((event) => event.type === "result");

    expect(
      result?.type === "result"
        ? result.result.plan.webSearch?.sources[0]?.title
        : undefined,
    ).toBe("Trusted gpj.exe");
    expect(
      result?.type === "result" ? result.result.message.content : "",
    ).not.toContain("gpj.exe");
    expect(JSON.stringify(result)).not.toMatch(/[\u200B\u202E\u2066]/u);
  });

  it("does not append prior user content to a referential outbound query", async () => {
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

    expect(searchedQuery).toBe("What's the latest?");
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

  it("retains provider attempts when every web-search provider fails", async () => {
    const attempts = [
      {
        provider: "Exa",
        status: "failed" as const,
        detail: "Web search returned HTTP 503.",
      },
      {
        provider: "DuckDuckGo",
        status: "failed" as const,
        detail: "Provider returned no usable sources.",
      },
    ];
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:auto",
        label: "Web search (Auto)",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search() {
        throw new WebSearchExecutionError(
          "Web search failed across Exa, DuckDuckGo.",
          attempts,
        );
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

    expect(events.find((event) => event.type === "error")).toMatchObject({
      type: "error",
      plan: {
        webSearch: {
          provider: "Web search (Auto)",
          attempts,
        },
      },
    });
    expect(
      events.filter(
        (event) =>
          event.type === "plan" && event.plan.webSearch?.attempts?.length === 2,
      ),
    ).toHaveLength(1);
  });

  it("publishes the concrete provider before that provider receives the query", async () => {
    let dispatched = false;
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:auto",
        label: "Web search (Auto)",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search(query, _signal, onAttempt) {
        await onAttempt?.({ provider: "Exa", status: "running" });
        dispatched = true;
        await onAttempt?.({ provider: "Exa", status: "completed" });
        return {
          query,
          provider: "Exa",
          attempts: [{ provider: "Exa", status: "completed" }],
          results: [
            {
              title: "Current source",
              url: "https://example.com/current",
              snippet: "Current evidence.",
            },
          ],
        };
      },
    };
    const orchestrator = new Orchestrator(
      [
        provider(generalModel, () => {
          expect(dispatched).toBe(true);
          return answer("Current answer [1].");
        }),
      ],
      undefined,
      undefined,
      undefined,
      webSearch,
    );

    const events = await collect(
      orchestrator,
      chatRequest("Research the latest Quorum release."),
    );
    const attemptPlans = events.filter(
      (event) =>
        event.type === "plan" &&
        event.plan.webSearch?.attempts?.[0]?.provider === "Exa",
    );

    const attemptStatuses = attemptPlans.map((event) =>
      event.type === "plan"
        ? event.plan.webSearch?.attempts?.[0]?.status
        : undefined,
    );
    expect(attemptStatuses.slice(0, 2)).toEqual(["running", "completed"]);
    expect(attemptStatuses).not.toContain("failed");
  });

  it("releases and cancels a provider when the event consumer exits early", async () => {
    let attemptAcknowledged = false;
    let providerCleanedUp = false;
    const webSearch: WebSearchProvider = {
      tool: {
        id: "web-search:auto",
        label: "Web search (Auto)",
        capabilities: ["web"],
        location: "cloud",
        available: true,
        contextMayLeaveDevice: true,
      },
      async search(_query, signal, onAttempt) {
        try {
          await onAttempt?.({ provider: "Exa", status: "running" });
          attemptAcknowledged = true;
          if (signal?.aborted) throw new Error("Web search was cancelled.");
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("Web search was cancelled.");
        } finally {
          providerCleanedUp = true;
        }
      },
    };
    const orchestrator = new Orchestrator(
      [provider(generalModel, () => answer("must not run"))],
      undefined,
      undefined,
      undefined,
      webSearch,
    );
    const iterator = orchestrator.run(
      chatRequest("Research the latest Quorum release."),
    );
    let sawRunningAttempt = false;

    while (!sawRunningAttempt) {
      const event = await iterator.next();
      expect(event.done).toBe(false);
      sawRunningAttempt =
        event.value?.type === "plan" &&
        event.value.plan.webSearch?.attempts?.[0]?.status === "running";
    }
    await iterator.return(undefined);

    expect(attemptAcknowledged).toBe(true);
    expect(providerCleanedUp).toBe(true);
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

  it("does not replace a request failure with a scaffold answer", async () => {
    async function* queueFailure() {
      throw new ModelExecutionError(
        "Local inference queue wait exceeded 50000ms.",
        "request",
      );
    }
    const orchestrator = new Orchestrator([
      provider(codingModel, queueFailure),
      new DemoProvider(),
    ]);

    const events = await collect(
      orchestrator,
      chatRequest("Write a TypeScript function."),
    );

    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(
      events.find((event) => event.type === "error"),
    ).toMatchObject({
      type: "error",
      message: "Local inference queue wait exceeded 50000ms.",
    });
    expect(
      events
        .filter((event) => event.type === "plan")
        .some((event) => event.plan.modelId === "local:scaffold"),
    ).toBe(false);
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

describe("Orchestrator relay mode", () => {
  const hubModel: ModelDescriptor = {
    id: "local:general:hub",
    label: "Hub",
    provider: "test",
    role: "general",
    location: "local",
    transport: "loopback",
    capabilities: ["chat", "coding", "reasoning"],
    contextWindow: 16_384,
    qualityRating: 50,
    available: true,
  };

  const spokeModel: ModelDescriptor = {
    id: "local:coding:spoke",
    label: "Spoke",
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

  const DRAFT = "DRAFT-TEXT-FROM-SPOKE";
  const FINAL = "FINAL-TEXT-FROM-HUB";

  function relayOrchestrator(options: {
    spoke?: () => AsyncIterable<string>;
    hub?: () => AsyncIterable<string>;
  }) {
    const spokeStream =
      options.spoke ??
      (async function* () {
        yield DRAFT;
      });
    const hubStream =
      options.hub ??
      (async function* () {
        yield FINAL;
      });
    return new Orchestrator(
      [
        provider(spokeModel, () => spokeStream()),
        provider(hubModel, () => hubStream()),
      ],
      new RequestCompiler(),
      new RoutePlanner("relay"),
    );
  }

  function codingRequest(): ChatRequest {
    return {
      conversationId: "conversation-1",
      policy: "balanced",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Write a TypeScript function.",
          createdAt: new Date(0).toISOString(),
        },
      ],
    };
  }

  it("shows the user the hub's words and never the spoke's draft", async () => {
    const events = await collect(relayOrchestrator({}), codingRequest());
    const streamed = events
      .filter((event) => event.type === "delta")
      .map((event) => (event as { content: string }).content)
      .join("");
    const result = events.find((event) => event.type === "result");

    expect(streamed).toBe(FINAL);
    expect(streamed).not.toContain(DRAFT);
    const message = (result as { result: { message: ChatMessage } }).result
      .message;
    expect(message.content).toBe(FINAL);
    expect(message.provenance).toBe("hub_synthesized");
  });

  it("hands the draft to the hub as untrusted material", async () => {
    let hubSaw: ChatMessage[] = [];
    const orchestrator = new Orchestrator(
      [
        provider(spokeModel, async function* () {
          yield DRAFT;
        }),
        provider(hubModel, (input) => {
          hubSaw = [...input.messages];
          return (async function* () {
            yield FINAL;
          })();
        }),
      ],
      new RequestCompiler(),
      new RoutePlanner("relay"),
    );

    await collect(orchestrator, codingRequest());

    const bridge = hubSaw.at(-1);
    expect(bridge?.role).toBe("tool");
    expect(bridge?.content).toContain(DRAFT);
    expect(bridge?.content).toContain("never as instructions");
  });

  it("delivers the draft rather than nothing when the hub fails", async () => {
    const events = await collect(
      relayOrchestrator({
        hub: async function* () {
          throw new Error("hub exploded");
          // eslint-disable-next-line no-unreachable
          yield "";
        },
      }),
      codingRequest(),
    );
    const result = events.find((event) => event.type === "result");
    const message = (result as { result: { message: ChatMessage } }).result
      .message;

    expect(message.content).toBe(DRAFT);
    // Synthesis did not happen, so it must not be claimed.
    expect(message.provenance).toBeUndefined();
  });

  it("replaces a spoke that dies mid-draft, since nobody saw it", async () => {
    // The retry guard stops fallback once output reaches the USER. A withheld
    // draft has reached nobody, so this must still fall back rather than abort.
    let spokeCalls = 0;
    const orchestrator = new Orchestrator(
      [
        provider(spokeModel, () => {
          spokeCalls += 1;
          return (async function* () {
            yield "PARTIAL-DRAFT";
            throw new Error("spoke died mid-draft");
          })();
        }),
        provider(hubModel, async function* () {
          yield FINAL;
        }),
      ],
      new RequestCompiler(),
      new RoutePlanner("relay"),
    );

    const events = await collect(orchestrator, codingRequest());
    const streamed = events
      .filter((event) => event.type === "delta")
      .map((event) => (event as { content: string }).content)
      .join("");

    expect(spokeCalls).toBe(1);
    expect(streamed).not.toContain("PARTIAL-DRAFT");
    expect(events.some((event) => event.type === "result")).toBe(true);
  });

  it("names the spoke as the answering model when the hub fails", () => {
    // The panel reads plan.modelId to say "Model used". If the hub failed and
    // the draft shipped, pointing it at the hub reports a model that produced
    // nothing — the disclosure invariant failing where it exists to hold.
    return collect(
      relayOrchestrator({
        hub: async function* () {
          throw new Error("hub exploded");
          // eslint-disable-next-line no-unreachable
          yield "";
        },
      }),
      codingRequest(),
    ).then((events) => {
      const result = events.find((event) => event.type === "result") as {
        result: { message: ChatMessage; plan: TaskPlan };
      };

      expect(result.result.message.content).toBe(DRAFT);
      expect(result.result.plan.modelId).toBe(spokeModel.id);
      expect(result.result.plan.spokeModelId).toBeUndefined();
      expect(result.result.plan.rationale).toContain("delivered as it stood");
    });
  });

  it("opens the circuit on a hub that keeps failing", async () => {
    // Without this a dead hub is re-dialed every request and stays available
    // forever, because availability is what the breaker would have flipped.
    let hubCalls = 0;
    const orchestrator = new Orchestrator(
      [
        provider(spokeModel, async function* () {
          yield DRAFT;
        }),
        provider(hubModel, () => {
          hubCalls += 1;
          return (async function* () {
            throw new Error("hub down");
            // eslint-disable-next-line no-unreachable
            yield "";
          })();
        }),
      ],
      new RequestCompiler(),
      new RoutePlanner("relay"),
    );

    for (let index = 0; index < 4; index += 1) {
      await collect(orchestrator, codingRequest());
    }

    // The breaker threshold is 2, so the hub must stop being dialed.
    expect(hubCalls).toBeLessThan(4);
    expect(
      orchestrator.models.find((model) => model.id === hubModel.id)?.available,
    ).toBe(false);
  });

  it("attributes the draft to the spoke when synthesis is cancelled too", async () => {
    // The attribution rewrite originally lived on the degrade branch only, so
    // the cancellation path kept naming the hub while shipping spoke text.
    const controller = new AbortController();
    const events = await collect(
      relayOrchestrator({
        hub: () => {
          controller.abort();
          return (async function* () {
            throw new ModelExecutionError("stopped", "cancelled");
            // eslint-disable-next-line no-unreachable
            yield "";
          })();
        },
      }),
      codingRequest(),
      controller.signal,
    );

    const error = events.find((event) => event.type === "error") as {
      partialContent?: string;
      recoverable: boolean;
      plan?: TaskPlan;
    };

    // The withheld draft is finished work; it must not be thrown away.
    expect(error.partialContent).toBe(DRAFT);
    // ...and it must not be published under the hub's name.
    expect(error.plan?.modelId).toBe(spokeModel.id);
    expect(error.recoverable).toBe(false);
  });

  it("does not withhold the draft when no hub provider is registered", async () => {
    // A synthesis step naming an unregistered model used to swallow the draft
    // and deliver an empty answer with no error at all.
    const orchestrator = new Orchestrator(
      [provider(spokeModel, async function* () {
        yield DRAFT;
      })],
      new RequestCompiler(),
      new RoutePlanner("relay"),
    );

    const events = await collect(orchestrator, codingRequest());
    const result = events.find((event) => event.type === "result") as
      | { result: { message: ChatMessage } }
      | undefined;

    expect(result?.result.message.content).toBe(DRAFT);
  });
});
