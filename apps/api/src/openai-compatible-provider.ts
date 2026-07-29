import type {
  Capability,
  ChatMessage,
  ExecutionLocation,
  ModelDescriptor,
  ModelProvider,
  ModelStreamInput,
} from "@quorum/core";

interface OpenAICompatibleOptions {
  id: string;
  label: string;
  provider: string;
  location: Exclude<ExecutionLocation, "device">;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  qualityRating: number;
  capabilities: Capability[];
}

interface CompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
}

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

function toProviderMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content,
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly model: ModelDescriptor;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #modelName: string;

  constructor(options: OpenAICompatibleOptions) {
    this.model = {
      id: options.id,
      label: options.label,
      provider: options.provider,
      location: options.location,
      transport: options.location === "local" ? "loopback" : "remote",
      capabilities: options.capabilities,
      contextWindow: options.contextWindow,
      qualityRating: options.qualityRating,
      available: true,
    };
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#modelName = options.model;
  }

  async *stream(input: ModelStreamInput): AsyncIterable<string> {
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.#modelName,
        messages: input.messages.map(toProviderMessage),
        stream: true,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(
        `${this.model.label} returned ${response.status}${detail ? `: ${detail}` : "."}`,
      );
    }

    if (!response.body) {
      throw new Error(`${this.model.label} returned an empty response.`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as CompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (content) yield content;
      return;
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
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          const payload = JSON.parse(data) as CompletionChunk;
          const content = payload.choices?.[0]?.delta?.content;
          if (content) yield content;
        }
      }

      if (done) break;
    }
  }
}

interface ModelListResponse {
  data?: Array<{ id?: string }>;
  models?: Array<{ name?: string; model?: string }>;
}

export async function discoverModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ connected: boolean; modelIds: string[] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_200);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return { connected: false, modelIds: [] };

    const payload = (await response.json()) as ModelListResponse;
    const modelIds = [
      ...(payload.data ?? []).flatMap((model) => (model.id ? [model.id] : [])),
      ...(payload.models ?? []).flatMap((model) =>
        model.name ? [model.name] : model.model ? [model.model] : [],
      ),
    ];
    return { connected: true, modelIds };
  } catch {
    return { connected: false, modelIds: [] };
  } finally {
    clearTimeout(timeout);
  }
}
