import type {
  RuntimeToolDescriptor,
  WebSearchProvider,
  WebSearchResponse,
  WebSearchResult,
} from "@quorum/core";
import { isIP } from "node:net";
import { z } from "zod";

const SEARCH_TIMEOUT_MS = 8_000;
const MAX_SEARCH_BODY_BYTES = 1024 * 1024;
const MAX_QUERY_CHARACTERS = 500;
const MAX_RESULTS = 5;
const MAX_TITLE_CHARACTERS = 240;
const MAX_SNIPPET_CHARACTERS = 1_200;
const MAX_URL_CHARACTERS = 2_048;
const MAX_CONCURRENT_SEARCHES = 2;
const MAX_SEARCHES_PER_MINUTE = 30;
let activeSearches = 0;
let recentSearches: number[] = [];

const searxngSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        content: z.string().optional(),
        publishedDate: z.string().optional(),
      }),
    )
    .default([]),
});

const braveSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().optional(),
            url: z.string().optional(),
            description: z.string().optional(),
            age: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});

function compactText(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/g, "");
  const ipVersion = isIP(normalized);
  if (
    (ipVersion === 0 && !normalized.includes(".")) ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".example")
  ) {
    return true;
  }
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    const [first = 0, second = 0] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && octets[2] === 100) ||
      (first === 203 && second === 0 && octets[2] === 113) ||
      first >= 224
    );
  }
  if (ipVersion === 6) {
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("fec") ||
      normalized.startsWith("fed") ||
      normalized.startsWith("fee") ||
      normalized.startsWith("fef") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
}

function acquireSearchSlot(): () => void {
  const now = Date.now();
  recentSearches = recentSearches.filter(
    (startedAt) => now - startedAt < 60_000,
  );
  if (activeSearches >= MAX_CONCURRENT_SEARCHES) {
    throw new Error("Web search is busy; try again shortly.");
  }
  if (recentSearches.length >= MAX_SEARCHES_PER_MINUTE) {
    throw new Error("Web search rate limit reached; try again in a minute.");
  }
  activeSearches += 1;
  recentSearches.push(now);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSearches = Math.max(0, activeSearches - 1);
  };
}

function safeResult(
  title: string | undefined,
  urlValue: string | undefined,
  snippet: string | undefined,
  publishedAt?: string,
): WebSearchResult | undefined {
  if (!title || !urlValue || !snippet) return undefined;
  if (urlValue.length > MAX_URL_CHARACTERS) return undefined;
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    isPrivateHostname(url.hostname)
  ) {
    return undefined;
  }

  const normalizedTitle = compactText(title, MAX_TITLE_CHARACTERS);
  const normalizedSnippet = compactText(snippet, MAX_SNIPPET_CHARACTERS);
  if (!normalizedTitle || !normalizedSnippet) return undefined;
  return {
    title: normalizedTitle,
    url: url.toString(),
    snippet: normalizedSnippet,
    ...(publishedAt
      ? { publishedAt: compactText(publishedAt, 120) }
      : {}),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let content = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      bytes += value.byteLength;
      if (bytes > MAX_SEARCH_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Web search response exceeded its safety limit.");
      }
      content += decoder.decode(value, { stream: true });
    }
    if (done) {
      content += decoder.decode();
      return JSON.parse(content);
    }
  }
}

function searchQuery(input: string): string {
  const query = compactText(input, MAX_QUERY_CHARACTERS);
  if (!query) throw new Error("Web search requires a non-empty query.");
  return query;
}

async function fetchSearch(
  url: URL,
  headers: HeadersInit,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new Error("Web search was cancelled.");
  const release = acquireSearchSlot();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Web search returned HTTP ${response.status}.`);
    }
    return await readBoundedJson(response);
  } catch (error) {
    if (signal?.aborted) throw new Error("Web search was cancelled.");
    if (controller.signal.aborted) {
      throw new Error(
        `Web search exceeded its ${SEARCH_TIMEOUT_MS / 1_000}-second limit.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    release();
  }
}

export class SearxngWebSearchProvider implements WebSearchProvider {
  readonly tool: RuntimeToolDescriptor;
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
    this.tool = {
      id: "web-search:searxng",
      label: "SearXNG",
      capabilities: ["web"],
      location: "local",
      available: true,
      contextMayLeaveDevice: true,
    };
  }

  async search(
    input: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input);
    const url = new URL("search", `${this.#baseUrl.replace(/\/$/, "")}/`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "en");
    url.searchParams.set("safesearch", "1");

    const payload = searxngSchema.parse(
      await fetchSearch(url, { accept: "application/json" }, signal),
    );
    const results = payload.results
      .flatMap((result) => {
        const normalized = safeResult(
          result.title,
          result.url,
          result.content,
          result.publishedDate,
        );
        return normalized ? [normalized] : [];
      })
      .slice(0, MAX_RESULTS);
    return { query, results };
  }
}

export class BraveWebSearchProvider implements WebSearchProvider {
  readonly tool: RuntimeToolDescriptor = {
    id: "web-search:brave",
    label: "Brave Search",
    capabilities: ["web"],
    location: "cloud",
    available: true,
    contextMayLeaveDevice: true,
  };
  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async search(
    input: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input);
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(MAX_RESULTS));
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("text_decorations", "false");
    url.searchParams.set("search_lang", "en");

    const payload = braveSchema.parse(
      await fetchSearch(
        url,
        {
          accept: "application/json",
          "x-subscription-token": this.#apiKey,
        },
        signal,
      ),
    );
    const results = (payload.web?.results ?? [])
      .flatMap((result) => {
        const normalized = safeResult(
          result.title,
          result.url,
          result.description,
          result.age,
        );
        return normalized ? [normalized] : [];
      })
      .slice(0, MAX_RESULTS);
    return { query, results };
  }
}
