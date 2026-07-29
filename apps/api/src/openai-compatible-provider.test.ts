import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discoverModels,
  estimateInputTokens,
  OpenAICompatibleProvider,
} from "./openai-compatible-provider.js";
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
        intentConfidence: 0.5,
        intentSource: "default",
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
    vi.useRealTimers();
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
      reasoningEffort: "none",
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
    expect(JSON.parse(String(request.body))).toMatchObject({
      reasoning_effort: "none",
      max_tokens: 2_048,
    });
  });

  it("budgets multibyte text more conservatively than ASCII", () => {
    expect(estimateInputTokens([{ content: "😀".repeat(12) }])).toBeGreaterThan(
      estimateInputTokens([{ content: "a".repeat(12) }]),
    );
  });

  it("rejects context that cannot fit before making a provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      id: "local:small",
      label: "small",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "small",
      contextWindow: 256,
      maxOutputTokens: 64,
      qualityRating: 10,
      capabilities: ["chat"],
    });
    const input = modelInput();
    input.messages[0] = {
      ...input.messages[0]!,
      content: "x".repeat(1_000),
    };

    const consume = async () => {
      for await (const _chunk of provider.stream(input)) {
        // The provider must fail before yielding or dispatching.
      }
    };

    await expect(consume()).rejects.toThrow("context is too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses a terminal SSE frame even when the stream closes without a blank line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}',
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    const provider = new OpenAICompatibleProvider({
      id: "local:stream",
      label: "stream",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "stream",
      contextWindow: 8_192,
      qualityRating: 10,
      capabilities: ["chat"],
    });

    const chunks: string[] = [];
    for await (const chunk of provider.stream(modelInput())) chunks.push(chunk);

    expect(chunks).toEqual(["complete"]);
  });

  it("rejects a truncated SSE stream after exposing its partial chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          'data: {"choices":[{"delta":{"content":"partial"}}]}',
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    const provider = new OpenAICompatibleProvider({
      id: "local:truncated",
      label: "truncated",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "truncated",
      contextWindow: 8_192,
      qualityRating: 10,
      capabilities: ["chat"],
    });
    const chunks: string[] = [];
    const consume = async () => {
      for await (const chunk of provider.stream(modelInput())) chunks.push(chunk);
    };

    await expect(consume()).rejects.toThrow(
      "stream ended before a terminal marker",
    );
    expect(chunks).toEqual(["partial"]);
  });

  it("aborts a provider that never produces its first output", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      }),
    );
    const provider = new OpenAICompatibleProvider({
      id: "local:timeout",
      label: "timeout",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "timeout",
      contextWindow: 8_192,
      qualityRating: 10,
      capabilities: ["chat"],
      timeouts: { firstTokenMs: 10, idleMs: 20, totalMs: 30 },
    });
    const consume = async () => {
      for await (const _chunk of provider.stream(modelInput())) {
        // This provider intentionally never yields.
      }
    };

    const expectation = expect(consume()).rejects.toThrow(
      "timed out waiting for first output after 10ms",
    );
    await vi.advanceTimersByTimeAsync(11);
    await expectation;
  });

  it("retries once without an unsupported reasoning option", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("unknown parameter: reasoning_effort", { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "negotiated" } }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      id: "local:negotiated",
      label: "negotiated",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "negotiated",
      contextWindow: 8_192,
      qualityRating: 10,
      capabilities: ["chat", "reasoning"],
      reasoningEffort: "none",
    });

    const chunks: string[] = [];
    for await (const chunk of provider.stream(modelInput())) chunks.push(chunk);
    const firstBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    const secondBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;

    expect(chunks).toEqual(["negotiated"]);
    expect(firstBody["reasoning_effort"]).toBe("none");
    expect(secondBody).not.toHaveProperty("reasoning_effort");
    expect(provider.model.inference?.reasoningEffort).toBeUndefined();
  });

  it("does not renegotiate reasoning settings for an unrelated 400", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("context length exceeded", { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      id: "local:no-renegotiation",
      label: "no-renegotiation",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "no-renegotiation",
      contextWindow: 8_192,
      qualityRating: 10,
      capabilities: ["chat", "reasoning"],
      reasoningEffort: "none",
    });
    const consume = async () => {
      for await (const _chunk of provider.stream(modelInput())) {
        // The provider rejects before output.
      }
    };

    await expect(consume()).rejects.toThrow("context length exceeded");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.model.inference?.reasoningEffort).toBe("none");
  });

  it("classifies persistent upstream HTTP failures as provider health errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("model not found", { status: 404 })),
    );
    const provider = new OpenAICompatibleProvider({
      id: "local:not-found",
      label: "not-found",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "not-found",
      contextWindow: 8_192,
      qualityRating: 10,
      capabilities: ["chat"],
    });
    const consume = async () => {
      for await (const _chunk of provider.stream(modelInput())) {
        // The provider rejects before output.
      }
    };

    await expect(consume()).rejects.toMatchObject({ kind: "provider" });
  });

  it("enforces the output limit for non-stream JSON completions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "x".repeat(1_000) } }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const provider = new OpenAICompatibleProvider({
      id: "local:json-limit",
      label: "json-limit",
      provider: "openai-compatible",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "json-limit",
      contextWindow: 8_192,
      maxOutputTokens: 1,
      qualityRating: 10,
      capabilities: ["chat"],
    });
    const consume = async () => {
      for await (const _chunk of provider.stream(modelInput())) {
        // The oversized response must not be yielded.
      }
    };

    await expect(consume()).rejects.toThrow("output safety limit");
  });

  it("validates HTTPS at the cloud provider boundary", () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          id: "cloud:unsafe",
          label: "unsafe",
          provider: "openai-compatible",
          location: "cloud",
          baseUrl: "http://api.example.com/v1",
          apiKey: "secret",
          model: "unsafe",
          contextWindow: 8_192,
          qualityRating: 10,
          capabilities: ["chat"],
        }),
    ).toThrow("QUORUM_CLOUD_BASE_URL must use HTTPS");
  });

  it("disables redirects during local model discovery", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "qwen3:4b" }] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverModels("http://127.0.0.1:11434/v1", "ollama"),
    ).resolves.toEqual({ connected: true, modelIds: ["qwen3:4b"] });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects an implausibly large discovered model list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: Array.from({ length: 257 }, (_, index) => ({
              id: `model-${index}`,
            })),
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(
      discoverModels("http://127.0.0.1:11434/v1", "ollama"),
    ).resolves.toEqual({ connected: false, modelIds: [] });
  });
});
