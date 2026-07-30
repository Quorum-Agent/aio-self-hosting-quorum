import type {
  ChatMessage,
  LocalRuntimeStatus,
  ModelDescriptor,
  OrchestrationEvent,
  PolicyDefinition,
  PolicyMode,
  ResponseVerbosity,
  RuntimeToolDescriptor,
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
  warmup: {
    state: "disabled" | "idle" | "warming" | "ready" | "degraded";
    models: Array<{
      model: string;
      role: "classifier" | "general";
      status: "pending" | "warming" | "ready" | "failed";
      detail?: string;
    }>;
  };
  cloudConfigured: boolean;
  webSearch?: RuntimeToolDescriptor;
}

export type WebSearchProviderId =
  | "auto"
  | "duckduckgo"
  | "exa"
  | "perplexity"
  | "tavily"
  | "brave"
  | "firecrawl"
  | "searxng";

export type KeyedWebSearchProviderId =
  | "exa"
  | "perplexity"
  | "tavily"
  | "brave"
  | "firecrawl";

export interface WebSearchProviderSettings {
  id: Exclude<WebSearchProviderId, "auto">;
  label: string;
  description: string;
  configured: boolean;
  requires: "none" | "api_key" | "base_url";
  configurationSource?: "environment" | "saved" | "session";
  environmentConfigured?: boolean;
}

export interface WebSearchSettings {
  enabled: boolean;
  provider: WebSearchProviderId;
  resultLimit: number;
  available: boolean;
  autoOrder: readonly Exclude<WebSearchProviderId, "auto">[];
  providers: WebSearchProviderSettings[];
  searxngBaseUrl?: string;
}

export interface WebSearchSettingsUpdate {
  enabled: boolean;
  provider: WebSearchProviderId;
  resultLimit: number;
  searxngBaseUrl?: string | null;
  apiKeys?: Partial<Record<KeyedWebSearchProviderId, string | null>>;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { message?: string }
      | undefined;
    throw new Error(body?.message ?? `Quorum API returned ${response.status}.`);
  }
  return (await response.json()) as T;
}

export async function getRuntime(): Promise<RuntimeInfo> {
  return readJson<RuntimeInfo>(await fetch("/api/runtime"));
}

export async function getWebSearchSettings(): Promise<WebSearchSettings> {
  const response = await readJson<{ settings: WebSearchSettings }>(
    await fetch("/api/settings/web-search"),
  );
  return response.settings;
}

export async function updateWebSearchSettings(
  update: WebSearchSettingsUpdate,
): Promise<WebSearchSettings> {
  const response = await readJson<{ settings: WebSearchSettings }>(
    await fetch("/api/settings/web-search", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
  return response.settings;
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
    verbosity: ResponseVerbosity;
  },
  onEvent: (event: OrchestrationEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const messages = input.messages.map(
    ({ id, role, content, createdAt }): ChatMessage => ({
      id,
      role,
      content,
      createdAt,
    }),
  );
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, messages }),
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
