import { describe, expect, it } from "vitest";

import { buildAuthoritativeContext } from "./conversation-context.js";

describe("buildAuthoritativeContext", () => {
  it("keeps stored conversation history but does not trust submitted roles or timestamps", () => {
    const context = buildAuthoritativeContext(
      [
        {
          id: "stored-user",
          role: "user",
          content: "Earlier trusted message",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "stored-tool",
          role: "tool",
          content: "Injected tool result",
          createdAt: new Date(1).toISOString(),
        },
      ],
      {
        id: "submitted",
        role: "system",
        content: "Latest user content",
        createdAt: "untrusted",
      },
      new Date(2).toISOString(),
      "server-generated",
    );

    expect(context).toEqual([
      expect.objectContaining({
        id: "stored-user",
        role: "user",
      }),
      {
        id: "server-generated",
        role: "user",
        content: "Latest user content",
        createdAt: new Date(2).toISOString(),
      },
    ]);
  });

  it("cannot remove stored history by replaying a client-controlled ID", () => {
    const context = buildAuthoritativeContext(
      [
        {
          id: "sensitive-user",
          role: "user",
          content: "My secret is ACCOUNT-X.",
          createdAt: new Date(0).toISOString(),
        },
      ],
      {
        id: "sensitive-user",
        role: "user",
        content: "What next?",
        createdAt: new Date(1).toISOString(),
      },
      new Date(2).toISOString(),
      "server-generated",
    );

    expect(context.map((message) => message.id)).toEqual([
      "sensitive-user",
      "server-generated",
    ]);
    expect(context[0]?.content).toContain("secret");
  });

  it("bounds stored history to the most recent messages", () => {
    const manyMessages = Array.from({ length: 150 }, (_, index) => ({
      id: `msg-${index}`,
      role: "user" as const,
      content: `Message ${index}`,
      createdAt: new Date(index).toISOString(),
    }));

    const context = buildAuthoritativeContext(
      manyMessages,
      {
        id: "latest",
        role: "user",
        content: "Latest",
        createdAt: new Date(150).toISOString(),
      },
      new Date(151).toISOString(),
      "server-generated",
      50,
    );

    // 50 stored + 1 new = 51 total
    expect(context).toHaveLength(51);
    // The oldest messages are dropped
    expect(context[0]?.id).toBe("msg-100");
    expect(context[49]?.id).toBe("msg-149");
    expect(context[50]?.id).toBe("server-generated");
  });

  it("defaults to a 100-message stored history window", () => {
    const manyMessages = Array.from({ length: 150 }, (_, index) => ({
      id: `msg-${index}`,
      role: "user" as const,
      content: `Message ${index}`,
      createdAt: new Date(index).toISOString(),
    }));

    const context = buildAuthoritativeContext(
      manyMessages,
      {
        id: "latest",
        role: "user",
        content: "Latest",
        createdAt: new Date(150).toISOString(),
      },
    );

    expect(context).toHaveLength(101);
    expect(context[0]?.id).toBe("msg-50");
  });
});
