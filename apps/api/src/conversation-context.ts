import { randomUUID } from "node:crypto";

import type { ChatMessage } from "@quorum/core";

/** Default maximum number of stored messages to include in context. */
const DEFAULT_MAX_STORED_MESSAGES = 100;

export function buildAuthoritativeContext(
  storedMessages: ChatMessage[],
  submittedUserMessage: ChatMessage,
  receivedAt = new Date().toISOString(),
  serverMessageId: string = randomUUID(),
  maxStoredMessages: number = DEFAULT_MAX_STORED_MESSAGES,
): ChatMessage[] {
  const trustedHistory = storedMessages.filter(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" &&
        message.content.trim().length > 0 &&
        message.execution?.status !== "running"),
  );
  // Sliding window: keep the most recent messages. Older history is dropped
  // here rather than at the provider, so the request compiler and planner
  // also see a bounded context — Q-08: no context truncation meant
  // conversations died at ~45KB with a hard failure and no recovery path.
  const windowedHistory = trustedHistory.slice(-maxStoredMessages);
  return [
    ...windowedHistory,
    {
      id: serverMessageId,
      role: "user",
      content: submittedUserMessage.content,
      createdAt: receivedAt,
    },
  ];
}
