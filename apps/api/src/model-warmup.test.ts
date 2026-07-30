import { afterEach, describe, expect, it, vi } from "vitest";

import { InferenceScheduler } from "./inference-scheduler.js";
import { warmLocalModel } from "./model-warmup.js";

describe("warmLocalModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Ollama's native keep-alive endpoint when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await warmLocalModel({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3:4b",
      scheduler: new InferenceScheduler(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:11434/api/generate",
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body).toMatchObject({
      model: "qwen3:4b",
      keep_alive: "30m",
      think: false,
      options: { num_predict: 1 },
    });
  });

  it("falls back to the OpenAI-compatible endpoint when native warmup is absent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await warmLocalModel({
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
      model: "qwen3:4b",
      scheduler: new InferenceScheduler(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
  });

  it("uses the compatible endpoint directly for a managed runtime", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await warmLocalModel({
      baseUrl: "http://127.0.0.1:43123/v1",
      apiKey: "ephemeral",
      model: "quorum-main",
      nativeOllama: false,
      scheduler: new InferenceScheduler(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:43123/v1/chat/completions",
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    );
    expect(body).not.toHaveProperty("reasoning_effort");
  });
});
