import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "@quorum/core";

import { streamChat } from "./api";

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
