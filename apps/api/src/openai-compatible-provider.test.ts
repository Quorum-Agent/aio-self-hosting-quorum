import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import type { ModelStreamInput } from "@quorum/core";

function modelInput(): ModelStreamInput {
  return {
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "What are your current capabilities?",
        createdAt: new Date(0).toISOString(),
      },
    ],
    request: {
      id: "request-1",
      conversationId: "conversation-1",
      messages: [],
      prompt: "What are your current capabilities?",
      policy: "balanced",
      requirements: {
        intent: "conversation",
        capabilities: ["chat"],
        requiresFreshness: false,
        containsSensitiveData: false,
      },
    },
  };
}

describe("OpenAICompatibleProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("grounds the model in Quorum's current identity and product capabilities", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "I am Quorum." } }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      id: "local:qwen3:4b",
      label: "qwen3:4b",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3:4b",
      contextWindow: 32_000,
      qualityRating: 60,
      capabilities: ["chat", "reasoning", "coding", "documents"],
    });

    const chunks: string[] = [];
    for await (const chunk of provider.stream(modelInput())) {
      chunks.push(chunk);
    }

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(chunks.join("")).toBe("I am Quorum.");
    expect(body.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("You are Quorum"),
    });
    expect(body.messages[0]?.content).toContain(
      "web browsing, external tools, project memory, and device control are not available yet",
    );
    expect(body.messages[0]?.content).toContain(
      "declared model capabilities: chat, reasoning, coding, documents",
    );
    expect(body.messages[1]).toMatchObject({
      role: "user",
      content: "What are your current capabilities?",
    });
  });
});
