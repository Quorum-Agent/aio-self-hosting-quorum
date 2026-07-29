import type {
  ChatMessage,
  LocalRuntimeStatus,
  ModelDescriptor,
  OrchestrationEvent,
  PolicyDefinition,
  PolicyMode,
} from "@quorum/core";

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeInfo {
  policies: PolicyDefinition[];
  models: ModelDescriptor[];
  localRuntime: LocalRuntimeStatus;
  cloudConfigured: boolean;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Quorum API returned ${response.status}.`);
  }
  return (await response.json()) as T;
}

export async function getRuntime(): Promise<RuntimeInfo> {
  return readJson<RuntimeInfo>(await fetch("/api/runtime"));
}

export async function getConversations(): Promise<ConversationRecord[]> {
  const response = await readJson<{ conversations: ConversationRecord[] }>(
    await fetch("/api/conversations"),
  );
  return response.conversations;
}

export async function getMessages(conversationId: string): Promise<ChatMessage[]> {
  const response = await readJson<{ messages: ChatMessage[] }>(
    await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`),
  );
  return response.messages;
}

function parseEventFrame(frame: string): OrchestrationEvent | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return data ? (JSON.parse(data) as OrchestrationEvent) : undefined;
}

export async function streamChat(
  input: {
    conversationId: string;
    messages: ChatMessage[];
    policy: PolicyMode;
  },
  onEvent: (event: OrchestrationEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok || !response.body) {
    const body = await response.text();
    throw new Error(body || `Quorum API returned ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const event = parseEventFrame(frame);
      if (event) onEvent(event);
    }

    if (done) {
      const event = parseEventFrame(buffer);
      if (event) onEvent(event);
      break;
    }
  }
}
