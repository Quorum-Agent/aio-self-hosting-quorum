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

describe("RequestCompiler", () => {
  const compiler = new RequestCompiler();

  it("does not treat a model capabilities question as fresh web research", () => {
    const compiled = compiler.compile(
      request("What are your current capabilities?"),
    );

    expect(compiled.requirements).toEqual({
      intent: "conversation",
      capabilities: ["chat"],
      requiresFreshness: false,
      containsSensitiveData: false,
    });
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
});
