import { describe, expect, it } from "vitest";

import { RequestCompiler } from "./request-compiler.js";
import type { ChatRequest } from "./types.js";

function request(content: string): ChatRequest {
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

function conversationRequest(contents: string[]): ChatRequest {
  return {
    conversationId: "conversation-1",
    policy: "balanced",
    messages: contents.map((content, index) => ({
      id: `message-${index}`,
      role: "user",
      content,
      createdAt: new Date(index).toISOString(),
    })),
  };
}

describe("RequestCompiler", () => {
  const compiler = new RequestCompiler();

  it("does not treat a model capabilities question as fresh web research", () => {
    const compiled = compiler.compile(
      request("What are your current capabilities?"),
    );

    expect(compiled.requirements).toEqual({
      intent: "conversation",
      intentConfidence: 0.5,
      intentSource: "default",
      capabilities: ["chat"],
      requiresFreshness: false,
      containsSensitiveData: false,
    });
    expect(compiled.verbosity).toBe("standard");
    expect(compiled.analysis).toEqual({
      source: "heuristic",
      intent: "conversation",
      confidence: 0.5,
      taskSummary: "What are your current capabilities?",
    });
  });

  it("preserves an explicit response verbosity preference", () => {
    expect(
      compiler.compile({
        ...request("Explain the routing decision."),
        verbosity: "detailed",
      }).verbosity,
    ).toBe("detailed");
  });

  it.each([
    "What is the current federal tax law?",
    "Who is currently the CEO?",
    "Give me today's weather.",
    "Research the latest Qwen release.",
  ])("keeps genuinely time-sensitive requests fresh: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.intent).toBe("research");
    expect(compiled.requirements.requiresFreshness).toBe(true);
    expect(compiled.requirements.capabilities).toEqual([
      "chat",
      "reasoning",
      "web",
    ]);
  });

  it.each([
    "Solve this equation: 2x + 4 = 12.",
    "Analyze the logic of this argument.",
    "Calculate the area of a circle with radius 5.",
  ])("classifies explicit reasoning work: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.intent).toBe("reasoning");
    expect(compiled.requirements.capabilities).toEqual([
      "chat",
      "reasoning",
    ]);
    expect(compiled.requirements.requiresFreshness).toBe(false);
  });

  it.each([
    "Write a SQL query to list overdue invoices.",
    "Refactor this Go method to avoid duplication.",
    "Solve this SQL query.",
    "Analyze the runtime complexity of this algorithm.",
  ])("recognizes concrete coding work without broad keywords: %s", (prompt) => {
    expect(compiler.compile(request(prompt)).requirements.intent).toBe("coding");
  });

  it.each([
    "There is no bug; tell me a joke.",
    "Do not calculate anything; just chat.",
    "What is API pricing?",
    "Analyze how I feel about this.",
  ])("does not route incidental keywords to an expert: %s", (prompt) => {
    expect(compiler.compile(request(prompt)).requirements.intent).toBe(
      "conversation",
    );
  });

  it.each([
    "Prove that sqrt(2) is irrational.",
    "What is 17 * 23?",
    "Solve this probability problem.",
  ])("recognizes direct mathematical reasoning: %s", (prompt) => {
    expect(compiler.compile(request(prompt)).requirements.intent).toBe(
      "reasoning",
    );
  });

  it("carries an established task through a referential follow-up", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Refactor this TypeScript function to remove duplication.",
        "Now make it faster.",
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      intentConfidence: 0.78,
      capabilities: ["chat", "coding"],
    });
  });

  it("carries specialist intent through chained contextual follow-ups", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Create a SQL PIVOT query with dynamic columns.",
        "Are there any better ways?",
        "What about for ORACLE?",
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      intentConfidence: 0.78,
      capabilities: ["chat", "coding"],
    });
  });

  it.each([
    "Are there any better ways?",
    "Is there a better approach?",
    "What other options are there?",
    "Any alternatives?",
    "What else?",
  ])("carries an established task through a comparative follow-up: %s", (prompt) => {
    const compiled = compiler.compile(
      conversationRequest([
        "Create a SQL PIVOT query with dynamic columns.",
        prompt,
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      intentConfidence: 0.78,
      capabilities: ["chat", "coding"],
    });
  });

  it("allows an explicit topic reset instead of carrying the prior route", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Solve this equation: 2x = 8.",
        "New topic: tell me a joke.",
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "default",
    });
  });

  it("does not cross an explicit reset on a later short follow-up", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Write a TypeScript function.",
        "New topic: tell me a joke.",
        "Why?",
      ]),
    );

    expect(compiled.requirements.intent).toBe("conversation");
  });

  it("does not cross an explicit reset while walking a follow-up chain", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Create a SQL PIVOT query with dynamic columns.",
        "Are there any better ways?",
        "New topic: tell me a joke.",
        "What about that?",
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "default",
    });
  });

  it.each([
    "What should I cook this weekend?",
    "Tell me about this composer.",
  ])("does not treat an unrelated use of a pronoun as a follow-up: %s", (prompt) => {
    const compiled = compiler.compile(
      conversationRequest(["Write a TypeScript function.", prompt]),
    );

    expect(compiled.requirements.intent).toBe("conversation");
  });

  it("detects sensitive data anywhere in the context sent to a model", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "My private key is in the earlier message.",
        "Now summarize that.",
      ]),
    );

    expect(compiled.requirements.containsSensitiveData).toBe(true);
  });

  it("uses a confident local prompt analysis for an ambiguous request", () => {
    const baseline = compiler.compile(request("Can you help me with this?"));
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "coding",
        confidence: 0.91,
        taskSummary: "Help with the current coding task.",
      },
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentConfidence: 0.91,
      intentSource: "classifier",
      capabilities: ["chat", "coding"],
    });
    expect(compiled.analysis).toMatchObject({
      source: "local_model",
      intent: "coding",
      taskSummary: "Help with the current coding task.",
      analyzer: {
        modelId: "local:classifier:test",
        modelLabel: "Tiny classifier",
      },
    });
  });

  it("keeps a strong deterministic signal when the tiny model conflicts", () => {
    const baseline = compiler.compile(
      request("Write a SQL query for dynamic pivot columns."),
    );
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "conversation",
        confidence: 0.9,
        taskSummary: "Discuss database tables.",
      },
    );

    expect(compiled.requirements.intent).toBe("coding");
    expect(compiled.analysis).toMatchObject({
      source: "hybrid",
      intent: "coding",
      analyzer: {
        intent: "conversation",
        confidence: 0.9,
      },
    });
  });

  it("protects inherited specialist context from a contradictory tiny model", () => {
    const baseline = compiler.compile(
      conversationRequest([
        "Create a SQL PIVOT query with dynamic columns.",
        "Are there any better ways?",
      ]),
    );
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "conversation",
        confidence: 1,
        taskSummary: "Discuss alternative approaches.",
      },
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      capabilities: ["chat", "coding"],
    });
    expect(compiled.analysis).toMatchObject({
      source: "hybrid",
      intent: "coding",
      analyzer: {
        intent: "conversation",
        confidence: 1,
      },
    });
  });

  it("never lets prompt analysis clear deterministic sensitive-data detection", () => {
    const baseline = compiler.compile(
      request("Use API key sk-exampleSecret12345 to help with this."),
    );
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "conversation",
        confidence: 0.95,
        taskSummary: "Help with a request.",
      },
    );

    expect(compiled.requirements.containsSensitiveData).toBe(true);
  });

  it.each([
    "Customer credential AKIAIOSFODNN7EXAMPLE",
    "The account number is 123-45-6789",
    "Use this API key for the request",
    "OPENAI_API_KEY=sk-exampleSecret12345",
    "api_key=private-value",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
  ])("recognizes common structured secret and credential signals: %s", (prompt) => {
    expect(
      compiler.compile(request(prompt)).requirements.containsSensitiveData,
    ).toBe(true);
  });
});
