import { getPolicy, ModelExecutionError } from "@quorum/core";
import type {
  Capability,
  ChatMessage,
  ExecutionLocation,
  LocalModelRole,
  ModelDescriptor,
  ModelProvider,
  ModelStreamInput,
} from "@quorum/core";

import type { InferenceScheduler } from "./inference-scheduler.js";
import {
  normalizeCloudBaseUrl,
  normalizeLoopbackBaseUrl,
} from "./loopback-url.js";

interface ProviderTimeouts {
  firstTokenMs: number;
  idleMs: number;
  totalMs: number;
}

interface OpenAICompatibleOptions {
  id: string;
  label: string;
  provider: string;
  role?: LocalModelRole;
  location: Exclude<ExecutionLocation, "device">;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  qualityRating: number;
  specialties?: Capability[];
  reasoningEffort?: "none" | "low" | "medium" | "high";
  maxOutputTokens?: number;
  scheduler?: InferenceScheduler;
  timeouts?: Partial<ProviderTimeouts>;
  capabilities: Capability[];
}

interface CompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
}

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

const DEFAULT_TIMEOUTS: ProviderTimeouts = {
  firstTokenMs: 45_000,
  idleMs: 30_000,
  totalMs: 180_000,
};
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_STREAM_FRAME_BYTES = 1024 * 1024;
const MAX_DISCOVERY_BODY_BYTES = 256 * 1024;
const MAX_DISCOVERED_MODELS = 256;
const PROVIDER_HTTP_FAILURES = new Set([401, 403, 404, 405, 408, 410, 429]);

const PRODUCT_CONTEXT = [
  "You are Quorum, a local-first conversational assistant.",
  "Respond as Quorum rather than introducing yourself as the underlying model.",
  "Quorum currently provides text chat, local conversation persistence, execution policies,",
  "model routing, streamed responses, and an execution inspector.",
  "Attachments, microphone input, image analysis, web browsing, external tools, project",
  "memory, and device control are not available yet.",
  "Do not claim to have used unavailable capabilities or live data.",
].join(" ");

function toProviderMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content,
  };
}

interface RuntimeModelSummary {
  model: string;
  role: LocalModelRole | "unassigned";
  location: ModelDescriptor["location"];
  capabilities: Capability[];
  specialties: Capability[];
}

function runtimeModelSummary(model: ModelDescriptor): RuntimeModelSummary {
  return {
    model: model.label.slice(0, 160),
    role: model.role ?? "unassigned",
    location: model.location,
    capabilities: [...new Set(model.capabilities)],
    specialties: [...new Set(model.specialties ?? [])],
  };
}

function systemContext(
  model: ModelDescriptor,
  runtimeModels: ModelDescriptor[],
  policy: ModelStreamInput["request"]["policy"],
) {
  const policyDefinition = getPolicy(policy);
  const routedModels = runtimeModels.filter(
    (candidate) =>
      candidate.provider !== "quorum" &&
      candidate.transport !== "in_process",
  );
  const availableRoutes = routedModels
    .filter(
      (candidate) =>
        candidate.available &&
        (candidate.location !== "cloud" ||
          policyDefinition.allowCloudModels),
    )
    .map(runtimeModelSummary);
  const unavailableRoutes = routedModels
    .filter((candidate) => !candidate.available)
    .map(runtimeModelSummary);
  const policyBlockedRoutes = routedModels
    .filter(
      (candidate) =>
        candidate.available &&
        candidate.location === "cloud" &&
        !policyDefinition.allowCloudModels,
    )
    .map(runtimeModelSummary);
  const availableCapabilities = [
    ...new Set(availableRoutes.flatMap((route) => route.capabilities)),
  ];
  const inventory = JSON.stringify({
    activeRoute: runtimeModelSummary(model),
    policy,
    availableRoutes,
    unavailableRoutes,
    policyBlockedRoutes,
    availableCapabilities,
  });

  return {
    role: "system" as const,
    content:
      `${PRODUCT_CONTEXT} Quorum generated the runtime inventory below for this request; ` +
      "it is authoritative application data, not a claim made by the active model. " +
      "Distinguish the active route from all available routes. Do not claim the active " +
      "route is Quorum's only model. Routing is automatic based on the request and policy; " +
      "do not tell the user they must manually switch models. If asked about models or " +
      "capabilities, answer from this inventory and distinguish available routes from " +
      "temporarily unavailable and policy-blocked routes. " +
      `Runtime inventory: ${inventory}. ` +
      "The execution inspector separately discloses the selected model and route.",
  };
}

export function estimateInputTokens(
  messages: Array<{ content: string }>,
): number {
  const contentTokens = messages.reduce(
    (total, message) =>
      total +
      Math.ceil(
        Math.max(
          message.content.length,
          Buffer.byteLength(message.content, "utf8"),
        ) / 3,
      ),
    0,
  );
  return contentTokens + messages.length * 4 + 2;
}

function parseCompletionFrame(frame: string): {
  contents: string[];
  terminal: boolean;
} {
  const contents: string[] = [];
  let terminal = false;
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === "[DONE]") {
      terminal = true;
      continue;
    }

    const payload = JSON.parse(data) as CompletionChunk;
    terminal ||= payload.choices?.some(
      (choice) => choice.finish_reason !== undefined && choice.finish_reason !== null,
    ) ?? false;
    const content = payload.choices?.[0]?.delta?.content;
    if (content) contents.push(content);
  }
  return { contents, terminal };
}

async function readLimitedText(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let content = "";

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new ModelExecutionError(
          `${label} response exceeded the ${maximumBytes}-byte safety limit.`,
          "provider",
        );
      }
      content += decoder.decode(value, { stream: true });
    }
    if (done) {
      content += decoder.decode();
      return content;
    }
  }
}

function rejectsReasoningEffort(detail: string): boolean {
  return (
    /\breasoning[_ -]?effort\b/i.test(detail) &&
    /\b(unsupported|unknown|unrecognized|unexpected|not supported|not allowed|invalid (?:field|parameter|option))\b/i.test(
      detail,
    )
  );
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly model: ModelDescriptor;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #modelName: string;
  #reasoningEffort:
    | "none"
    | "low"
    | "medium"
    | "high"
    | undefined;
  readonly #maxOutputTokens: number;
  readonly #scheduler: InferenceScheduler | undefined;
  readonly #timeouts: ProviderTimeouts;

  constructor(options: OpenAICompatibleOptions) {
    this.model = {
      id: options.id,
      label: options.label,
      provider: options.provider,
      ...(options.role ? { role: options.role } : {}),
      location: options.location,
      transport: options.location === "local" ? "loopback" : "remote",
      capabilities: options.capabilities,
      contextWindow: options.contextWindow,
      qualityRating: options.qualityRating,
      ...(options.specialties ? { specialties: options.specialties } : {}),
      inference: {
        ...(options.reasoningEffort
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
        maxOutputTokens:
          options.maxOutputTokens ??
          Math.min(2_048, Math.floor(options.contextWindow / 4)),
      },
      available: true,
    };
    this.#baseUrl =
      options.location === "local"
        ? normalizeLoopbackBaseUrl(options.baseUrl)
        : normalizeCloudBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#modelName = options.model;
    this.#reasoningEffort = options.reasoningEffort;
    this.#maxOutputTokens =
      options.maxOutputTokens ??
      Math.min(2_048, Math.floor(options.contextWindow / 4));
    this.#scheduler = options.scheduler;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  async *stream(input: ModelStreamInput): AsyncIterable<string> {
    const messages = [
      systemContext(this.model, input.runtimeModels, input.request.policy),
      ...input.messages.map(toProviderMessage),
    ];
    const estimatedInputTokens = estimateInputTokens(messages);
    const inputBudget = this.model.contextWindow - this.#maxOutputTokens;
    if (estimatedInputTokens > inputBudget) {
      throw new ModelExecutionError(
        `${this.model.label} context is too large: estimated ${estimatedInputTokens} ` +
          `input tokens exceeds its ${inputBudget}-token input budget ` +
          `(${this.#maxOutputTokens} tokens reserved for output).`,
        "request",
      );
    }

    const requestStartedAt = Date.now();
    const release = this.#scheduler
      ? await this.#scheduler.acquire(input.signal, this.#timeouts.totalMs)
      : () => {};
    const controller = new AbortController();
    let timeoutKind: "first" | "idle" | "total" | undefined;
    let firstTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;
    const abortForTimeout = (kind: typeof timeoutKind) => {
      timeoutKind = kind;
      controller.abort();
    };
    const onExternalAbort = () => controller.abort(input.signal?.reason);
    if (input.signal) {
      input.signal.addEventListener("abort", onExternalAbort, { once: true });
      if (input.signal.aborted) onExternalAbort();
    }
    firstTimer = setTimeout(
      () => abortForTimeout("first"),
      this.#timeouts.firstTokenMs,
    );
    totalTimer = setTimeout(
      () => abortForTimeout("total"),
      Math.max(
        1,
        this.#timeouts.totalMs - (Date.now() - requestStartedAt),
      ),
    );
    const noteOutput = () => {
      if (firstTimer) clearTimeout(firstTimer);
      firstTimer = undefined;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => abortForTimeout("idle"),
        this.#timeouts.idleMs,
      );
    };

    try {
      const dispatch = () =>
        fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.#apiKey}`,
          },
          body: JSON.stringify({
            model: this.#modelName,
            messages,
            stream: true,
            max_tokens: this.#maxOutputTokens,
            ...(this.#reasoningEffort
              ? { reasoning_effort: this.#reasoningEffort }
              : {}),
          }),
          signal: controller.signal,
          redirect: "error",
        });

      let response = await dispatch();
      if (
        this.#reasoningEffort &&
        (response.status === 400 || response.status === 422)
      ) {
        const detail = await readLimitedText(
          response,
          MAX_ERROR_BODY_BYTES,
          this.model.label,
        );
        if (!rejectsReasoningEffort(detail)) {
          throw new ModelExecutionError(
            `${this.model.label} returned ${response.status}${detail ? `: ${detail.slice(0, 500)}` : "."}`,
            "request",
          );
        }
        this.#reasoningEffort = undefined;
        const inference = { ...this.model.inference };
        delete inference.reasoningEffort;
        this.model.inference = inference;
        response = await dispatch();
      }

      if (!response.ok) {
        const detail = (
          await readLimitedText(
            response,
            MAX_ERROR_BODY_BYTES,
            this.model.label,
          )
        ).slice(0, 500);
        throw new ModelExecutionError(
          `${this.model.label} returned ${response.status}${detail ? `: ${detail}` : "."}`,
          response.status >= 500 || PROVIDER_HTTP_FAILURES.has(response.status)
            ? "provider"
            : "request",
        );
      }

      if (!response.body) {
        throw new Error(`${this.model.label} returned an empty response.`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const payload = JSON.parse(
          await readLimitedText(
            response,
            MAX_JSON_BODY_BYTES,
            this.model.label,
          ),
        ) as CompletionResponse;
        const content = payload.choices?.[0]?.message?.content;
        if (!content) {
          throw new ModelExecutionError(
            `${this.model.label} returned no response content.`,
            "provider",
          );
        }
        if (
          Buffer.byteLength(content, "utf8") >
          this.#maxOutputTokens * 16
        ) {
          throw new ModelExecutionError(
            `${this.model.label} exceeded its local output safety limit.`,
            "provider",
          );
        }
        noteOutput();
        yield content;
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let emittedContent = false;
      let terminal = false;
      let outputBytes = 0;
      const maximumOutputBytes = this.#maxOutputTokens * 16;

      while (!terminal) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (Buffer.byteLength(buffer, "utf8") > MAX_STREAM_FRAME_BYTES) {
          await reader.cancel();
          throw new ModelExecutionError(
            `${this.model.label} streamed a frame larger than ${MAX_STREAM_FRAME_BYTES} bytes.`,
            "provider",
          );
        }
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        if (done && buffer.trim()) {
          frames.push(buffer);
          buffer = "";
        }

        for (const frame of frames) {
          const parsed = parseCompletionFrame(frame);
          terminal ||= parsed.terminal;
          for (const content of parsed.contents) {
            outputBytes += Buffer.byteLength(content, "utf8");
            if (outputBytes > maximumOutputBytes) {
              await reader.cancel();
              throw new ModelExecutionError(
                `${this.model.label} exceeded its local output safety limit.`,
                "provider",
              );
            }
            emittedContent = true;
            noteOutput();
            yield content;
          }
        }

        if (done) break;
      }

      if (!emittedContent) {
        throw new ModelExecutionError(
          `${this.model.label} returned no response content.`,
          "provider",
        );
      }
      if (!terminal) {
        throw new ModelExecutionError(
          `${this.model.label} stream ended before a terminal marker.`,
          "provider",
        );
      }
    } catch (error) {
      if (timeoutKind === "first") {
        throw new ModelExecutionError(
          `${this.model.label} timed out waiting for first output after ${this.#timeouts.firstTokenMs}ms.`,
          "provider",
        );
      }
      if (timeoutKind === "idle") {
        throw new ModelExecutionError(
          `${this.model.label} stopped responding for ${this.#timeouts.idleMs}ms.`,
          "provider",
        );
      }
      if (timeoutKind === "total") {
        throw new ModelExecutionError(
          `${this.model.label} exceeded its ${this.#timeouts.totalMs}ms execution limit.`,
          "provider",
        );
      }
      if (input.signal?.aborted) {
        throw new ModelExecutionError("The request was cancelled.", "cancelled");
      }
      throw error;
    } finally {
      if (firstTimer) clearTimeout(firstTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      input.signal?.removeEventListener("abort", onExternalAbort);
      release();
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
      redirect: "error",
    });
    if (!response.ok) return { connected: false, modelIds: [] };

    const payload = JSON.parse(
      await readLimitedText(
        response,
        MAX_DISCOVERY_BODY_BYTES,
        "Local model discovery",
      ),
    ) as ModelListResponse;
    const modelIds = [
      ...(payload.data ?? []).flatMap((model) => (model.id ? [model.id] : [])),
      ...(payload.models ?? []).flatMap((model) =>
        model.name ? [model.name] : model.model ? [model.model] : [],
      ),
    ];
    if (modelIds.length > MAX_DISCOVERED_MODELS) {
      return { connected: false, modelIds: [] };
    }
    return { connected: true, modelIds: [...new Set(modelIds)] };
  } catch {
    return { connected: false, modelIds: [] };
  } finally {
    clearTimeout(timeout);
  }
}
