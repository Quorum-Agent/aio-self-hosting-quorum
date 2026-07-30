import { randomUUID } from "node:crypto";

import type { ChatMessage } from "@quorum/core";

export function buildAuthoritativeContext(
  storedMessages: ChatMessage[],
  submittedUserMessage: ChatMessage,
  receivedAt = new Date().toISOString(),
  serverMessageId: string = randomUUID(),
): ChatMessage[] {
  const trustedHistory = storedMessages.filter(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" &&
        message.content.trim().length > 0 &&
        message.execution?.status !== "running"),
  );
  return [
    ...trustedHistory,
    {
      id: serverMessageId,
      role: "user",
      content: submittedUserMessage.content,
      createdAt: receivedAt,
    },
  ];
}
