import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@quorum/core";

import {
  getWebSearchSettings,
  streamChat,
  updateWebSearchSettings,
} from "./api";

describe("streamChat", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not echo persisted execution records back in chat requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const historicalMessage: ChatMessage = {
      id: "message-1",
      role: "assistant",
      content: "Historical response",
      createdAt: new Date(0).toISOString(),
      execution: {} as NonNullable<ChatMessage["execution"]>,
    };

    await streamChat(
      {
        conversationId: "conversation-1",
        messages: [historicalMessage],
        policy: "balanced",
        verbosity: "detailed",
      },
      () => undefined,
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(body.messages[0]).toEqual({
      id: "message-1",
      role: "assistant",
      content: "Historical response",
      createdAt: new Date(0).toISOString(),
    });
  });
});

describe("web-search settings API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads settings and sends only credential changes", async () => {
    const settings = {
      enabled: true,
      provider: "auto" as const,
      resultLimit: 5,
      available: true,
      autoOrder: ["duckduckgo" as const],
      providers: [
        {
          id: "duckduckgo" as const,
          label: "DuckDuckGo",
          description: "Keyless",
          configured: true,
          requires: "none" as const,
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ settings }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ settings }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    expect(await getWebSearchSettings()).toEqual(settings);
    await updateWebSearchSettings({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: { exa: "replacement" },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/settings/web-search");
    const update = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(update.method).toBe("PUT");
    expect(JSON.parse(String(update.body))).toEqual({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: { exa: "replacement" },
    });
  });

  it("surfaces the API's safe validation message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ message: "Perplexity is not configured." }),
          { status: 400 },
        ),
      ),
    );

    await expect(getWebSearchSettings()).rejects.toThrow(
      "Perplexity is not configured.",
    );
  });
});
