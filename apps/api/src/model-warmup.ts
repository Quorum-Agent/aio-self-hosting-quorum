import type { InferenceScheduler } from "./inference-scheduler.js";

interface WarmupOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  scheduler: InferenceScheduler;
}

const WARMUP_TIMEOUT_MS = 180_000;
const KEEP_ALIVE = "30m";
const MAX_WARMUP_RESPONSE_BYTES = 64 * 1024;

function nativeOllamaUrl(baseUrl: string): string | undefined {
  const url = new URL(baseUrl);
  if (!/\/v1\/?$/.test(url.pathname)) return undefined;
  url.pathname = `${url.pathname.replace(/\/v1\/?$/, "")}/api/generate`;
  return url.toString();
}

async function consumeBounded(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let totalBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > MAX_WARMUP_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Model warmup response exceeded its safety limit.");
      }
    }
    if (done) return;
  }
}

export async function warmLocalModel(options: WarmupOptions): Promise<void> {
  const release = await options.scheduler.acquire(
    undefined,
    WARMUP_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);

  try {
    const ollamaUrl = nativeOllamaUrl(options.baseUrl);
    if (ollamaUrl) {
      const response = await fetch(ollamaUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          prompt: "",
          stream: false,
          keep_alive: KEEP_ALIVE,
          think: false,
          options: { num_predict: 1 },
        }),
        signal: controller.signal,
        redirect: "error",
      });
      await consumeBounded(response);
      if (response.ok) return;
      if (response.status !== 404 && response.status !== 405) {
        throw new Error(
          `${options.model} warmup returned ${response.status}.`,
        );
      }
    }

    const response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: "user", content: "Reply OK." }],
        stream: false,
        max_tokens: 2,
        reasoning_effort: "none",
      }),
      signal: controller.signal,
      redirect: "error",
    });
    await consumeBounded(response);
    if (!response.ok) {
      throw new Error(`${options.model} warmup returned ${response.status}.`);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `${options.model} warmup exceeded ${WARMUP_TIMEOUT_MS}ms.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    release();
  }
}
