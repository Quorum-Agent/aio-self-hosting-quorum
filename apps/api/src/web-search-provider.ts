import {
  WebSearchExecutionError,
  type RuntimeToolDescriptor,
  type WebSearchAttempt,
  type WebSearchProvider,
  type WebSearchResponse,
  type WebSearchResult,
} from "@quorum/core";
import { z } from "zod";

import {
  WEB_SEARCH_PROVIDER_IDS,
  type KeyedWebSearchProviderId,
  type WebSearchConfig,
  type WebSearchProviderId,
} from "./config.js";
import {
  isLoopbackHostname,
  isPrivateHostname,
  normalizeSearchBaseUrl,
} from "./outbound-url.js";

const SEARCH_TIMEOUT_MS = 8_000;
const MAX_SEARCH_BODY_BYTES = 1024 * 1024;
const MAX_QUERY_CHARACTERS = 500;
const DEFAULT_RESULT_LIMIT = 5;
const MIN_RESULTS = 3;
const MAX_RESULTS = 10;
const MAX_TITLE_CHARACTERS = 240;
const MAX_SNIPPET_CHARACTERS = 2_400;
const MAX_URL_CHARACTERS = 2_048;
const MAX_API_KEY_CHARACTERS = 4_096;
const MAX_CONCURRENT_SEARCHES = 2;
const MAX_SEARCHES_PER_MINUTE = 30;

export const AUTO_PROVIDER_ORDER = [
  "exa",
  "perplexity",
  "tavily",
  "brave",
  "firecrawl",
  "searxng",
  "duckduckgo",
] as const satisfies readonly Exclude<WebSearchProviderId, "auto">[];

const KEYED_PROVIDER_IDS = [
  "exa",
  "perplexity",
  "tavily",
  "brave",
  "firecrawl",
] as const satisfies readonly KeyedWebSearchProviderId[];

let activeSearches = 0;
let recentSearches: number[] = [];
const chargedSearchSignals = new WeakSet<AbortSignal>();

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

const tavilySchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        content: z.string().optional(),
        published_date: z.string().optional(),
      }),
    )
    .default([]),
});

const exaSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        publishedDate: z.string().nullable().optional(),
        text: z.string().optional(),
        highlights: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

const perplexitySchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        snippet: z.string().optional(),
        date: z.string().nullable().optional(),
        last_updated: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

const firecrawlSchema = z.object({
  data: z
    .object({
      web: z
        .array(
          z.object({
            title: z.string().optional(),
            url: z.string().optional(),
            description: z.string().optional(),
            markdown: z.string().optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});

const storedSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(WEB_SEARCH_PROVIDER_IDS).optional(),
  resultLimit: z.number().int().min(MIN_RESULTS).max(MAX_RESULTS).optional(),
  searxngBaseUrl: z.string().max(MAX_URL_CHARACTERS).optional(),
});

export interface StoredWebSearchSettings {
  enabled?: boolean;
  provider?: WebSearchProviderId;
  resultLimit?: number;
  searxngBaseUrl?: string;
}

export interface WebSearchSettingsUpdate {
  enabled: boolean;
  provider: WebSearchProviderId;
  resultLimit: number;
  searxngBaseUrl?: string | null;
  apiKeys?: Partial<Record<KeyedWebSearchProviderId, string | null>>;
}

export interface WebSearchProviderSettingsView {
  id: Exclude<WebSearchProviderId, "auto">;
  label: string;
  description: string;
  configured: boolean;
  requires: "none" | "api_key" | "base_url";
  configurationSource?: "environment" | "saved" | "session";
  environmentConfigured?: boolean;
}

export interface WebSearchSettingsView {
  enabled: boolean;
  provider: WebSearchProviderId;
  resultLimit: number;
  available: boolean;
  autoOrder: readonly Exclude<WebSearchProviderId, "auto">[];
  providers: WebSearchProviderSettingsView[];
  searxngBaseUrl?: string;
}

interface EffectiveWebSearchSettings {
  enabled: boolean;
  provider: WebSearchProviderId;
  resultLimit: number;
  searxngBaseUrl?: string;
  apiKeys: Partial<Record<KeyedWebSearchProviderId, string>>;
}

interface ProviderDefinition {
  id: Exclude<WebSearchProviderId, "auto">;
  label: string;
  description: string;
  requires: WebSearchProviderSettingsView["requires"];
}

const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    description: "Keyless search that works immediately.",
    requires: "none",
  },
  {
    id: "exa",
    label: "Exa",
    description: "Neural web search with extracted result content.",
    requires: "api_key",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    description: "Ranked web results from the Perplexity Search API.",
    requires: "api_key",
  },
  {
    id: "tavily",
    label: "Tavily",
    description: "Search results optimized for language-model grounding.",
    requires: "api_key",
  },
  {
    id: "brave",
    label: "Brave Search",
    description: "Independent search index through the Brave Search API.",
    requires: "api_key",
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    description: "Web search with clean result descriptions.",
    requires: "api_key",
  },
  {
    id: "searxng",
    label: "SearXNG",
    description: "A user-controlled metasearch instance on this device.",
    requires: "base_url",
  },
];

function compactText(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function acquireSearchSlot(signal?: AbortSignal): () => void {
  const now = Date.now();
  recentSearches = recentSearches.filter(
    (startedAt) => now - startedAt < 60_000,
  );
  if (activeSearches >= MAX_CONCURRENT_SEARCHES) {
    throw new Error("Web search is busy; try again shortly.");
  }
  const alreadyCharged = signal
    ? chargedSearchSignals.has(signal)
    : false;
  if (!alreadyCharged && recentSearches.length >= MAX_SEARCHES_PER_MINUTE) {
    throw new Error("Web search rate limit reached; try again in a minute.");
  }
  activeSearches += 1;
  if (!alreadyCharged) {
    recentSearches.push(now);
    if (signal) chargedSearchSignals.add(signal);
  }
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
  publishedAt?: string | null,
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

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) return "";
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
      return content;
    }
  }
}

function searchQuery(
  input: string,
  maxCharacters = MAX_QUERY_CHARACTERS,
  maxWords?: number,
): string {
  const compacted = compactText(input, maxCharacters);
  const query =
    maxWords === undefined
      ? compacted
      : compacted.split(/\s+/u).slice(0, maxWords).join(" ");
  if (!query) throw new Error("Web search requires a non-empty query.");
  return query;
}

async function fetchSearch(
  url: URL,
  init: Omit<RequestInit, "signal" | "redirect">,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Web search was cancelled.");
  const release = acquireSearchSlot(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const forwardAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Web search returned HTTP ${response.status}.`);
    }
    return await readBoundedBody(response);
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

async function fetchJson(
  url: URL,
  init: Omit<RequestInit, "signal" | "redirect">,
  signal?: AbortSignal,
): Promise<unknown> {
  const body = await fetchSearch(url, init, signal);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Web search returned an invalid JSON response.");
  }
}

function jsonRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Omit<RequestInit, "signal" | "redirect"> {
  return {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function decodeHtml(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/giu,
    (_match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized.startsWith("#x")) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return Number.isFinite(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : " ";
      }
      if (normalized.startsWith("#")) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return Number.isFinite(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : " ";
      }
      return namedEntities[normalized] ?? " ";
    },
  );
}

function stripHtml(value: string): string {
  return compactText(decodeHtml(value.replace(/<[^>]+>/gu, " ")), MAX_SNIPPET_CHARACTERS);
}

function htmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*([\"'])(.*?)\\1`, "iu"),
  );
  return match?.[2] ? decodeHtml(match[2]) : undefined;
}

function hasHtmlClass(attributes: string, className: string): boolean {
  return (
    htmlAttribute(attributes, "class")
      ?.split(/\s+/u)
      .includes(className) ?? false
  );
}

function duckDuckGoDestination(href: string): string | undefined {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    if (
      url.hostname === "duckduckgo.com" ||
      url.hostname.endsWith(".duckduckgo.com")
    ) {
      return url.searchParams.get("uddg") ?? undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseDuckDuckGoResults(
  html: string,
  resultLimit: number,
): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockPattern =
    /<div\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bresult\b|$)/giu;

  for (const blockMatch of html.matchAll(blockPattern)) {
    const block = blockMatch[1] ?? "";
    let title: string | undefined;
    let href: string | undefined;
    let snippet: string | undefined;
    const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/giu;
    for (const elementMatch of block.matchAll(anchorPattern)) {
      const attributes = elementMatch[1] ?? "";
      const content = elementMatch[2] ?? "";
      if (!title && hasHtmlClass(attributes, "result__a")) {
        title = stripHtml(content);
        href = htmlAttribute(attributes, "href");
      }
      if (!snippet && hasHtmlClass(attributes, "result__snippet")) {
        snippet = stripHtml(content);
      }
    }
    if (!snippet) {
      const snippetMatch = block.match(
        /<([a-z][a-z0-9]*)\b([^>]*)>([\s\S]*?)<\/\1>/iu,
      );
      if (
        snippetMatch?.[2] &&
        hasHtmlClass(snippetMatch[2], "result__snippet")
      ) {
        snippet = stripHtml(snippetMatch[3] ?? "");
      }
    }
    const normalized = safeResult(
      title,
      href ? duckDuckGoDestination(href) : undefined,
      snippet,
    );
    if (normalized) results.push(normalized);
    if (results.length >= resultLimit) break;
  }
  return results;
}

function providerTool(
  id: Exclude<WebSearchProviderId, "auto">,
  label: string,
  location: RuntimeToolDescriptor["location"] = "cloud",
): RuntimeToolDescriptor {
  return {
    id: `web-search:${id}`,
    label,
    capabilities: ["web"],
    location,
    available: true,
    contextMayLeaveDevice: true,
  };
}

export class DuckDuckGoWebSearchProvider implements WebSearchProvider {
  readonly tool = providerTool("duckduckgo", "DuckDuckGo");
  readonly #resultLimit: number;

  constructor(resultLimit = DEFAULT_RESULT_LIMIT) {
    this.#resultLimit = resultLimit;
  }

  async search(
    input: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input);
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    const html = await fetchSearch(
      url,
      {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.8",
          "user-agent":
            "Mozilla/5.0 (compatible; Quorum/0.1; +https://github.com/)",
        },
      },
      signal,
    );
    return {
      query,
      results: parseDuckDuckGoResults(html, this.#resultLimit),
    };
  }
}

export class SearxngWebSearchProvider implements WebSearchProvider {
  readonly tool: RuntimeToolDescriptor;
  readonly #baseUrl: string;
  readonly #resultLimit: number;

  constructor(baseUrl: string, resultLimit = DEFAULT_RESULT_LIMIT) {
    this.#baseUrl = normalizeSearchBaseUrl(baseUrl, "SearXNG base URL");
    this.#resultLimit = resultLimit;
    this.tool = providerTool(
      "searxng",
      "SearXNG",
      isLoopbackHostname(new URL(this.#baseUrl).hostname) ? "local" : "cloud",
    );
  }

  async search(
    input: string,
    signal?: AbortSignal,
    onAttempt?: (
      attempt: WebSearchAttempt,
    ) => void | Promise<void>,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input);
    const url = new URL("search", `${this.#baseUrl}/`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("language", "en");
    url.searchParams.set("safesearch", "1");

    const payload = searxngSchema.parse(
      await fetchJson(
        url,
        { headers: { accept: "application/json" } },
        signal,
      ),
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
      .slice(0, this.#resultLimit);
    return { query, results };
  }
}

export class BraveWebSearchProvider implements WebSearchProvider {
  readonly tool = providerTool("brave", "Brave Search");
  readonly #apiKey: string;
  readonly #resultLimit: number;

  constructor(apiKey: string, resultLimit = DEFAULT_RESULT_LIMIT) {
    this.#apiKey = apiKey;
    this.#resultLimit = resultLimit;
  }

  async search(
    input: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input, 400, 50);
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(this.#resultLimit));
    url.searchParams.set("safesearch", "moderate");
    url.searchParams.set("text_decorations", "false");
    url.searchParams.set("search_lang", "en");

    const payload = braveSchema.parse(
      await fetchJson(
        url,
        {
          headers: {
            accept: "application/json",
            "x-subscription-token": this.#apiKey,
          },
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
      .slice(0, this.#resultLimit);
    return { query, results };
  }
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  readonly tool = providerTool("tavily", "Tavily");
  readonly #apiKey: string;
  readonly #resultLimit: number;

  constructor(apiKey: string, resultLimit = DEFAULT_RESULT_LIMIT) {
    this.#apiKey = apiKey;
    this.#resultLimit = resultLimit;
  }

  async search(
    input: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input);
    const payload = tavilySchema.parse(
      await fetchJson(
        new URL("https://api.tavily.com/search"),
        jsonRequest(
          {
            query,
            search_depth: "basic",
            include_answer: false,
            include_raw_content: false,
            max_results: this.#resultLimit,
          },
          { authorization: `Bearer ${this.#apiKey}` },
        ),
        signal,
      ),
    );
    return {
      query,
      results: payload.results
        .flatMap((result) => {
          const normalized = safeResult(
            result.title,
            result.url,
            result.content,
            result.published_date,
          );
          return normalized ? [normalized] : [];
        })
        .slice(0, this.#resultLimit),
    };
  }
}

export class ExaWebSearchProvider implements WebSearchProvider {
  readonly tool = providerTool("exa", "Exa");
  readonly #apiKey: string;
  readonly #resultLimit: number;

  constructor(apiKey: string, resultLimit = DEFAULT_RESULT_LIMIT) {
    this.#apiKey = apiKey;
    this.#resultLimit = resultLimit;
  }

  async search(
    input: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input);
    const payload = exaSchema.parse(
      await fetchJson(
        new URL("https://api.exa.ai/search"),
        jsonRequest(
          {
            query,
            type: "auto",
            numResults: this.#resultLimit,
            contents: {
              text: { maxCharacters: MAX_SNIPPET_CHARACTERS },
            },
          },
          { "x-api-key": this.#apiKey },
        ),
        signal,
      ),
    );
    return {
      query,
      results: payload.results
        .flatMap((result) => {
          const normalized = safeResult(
            result.title,
            result.url,
            result.text ?? result.highlights?.join(" "),
            result.publishedDate,
          );
          return normalized ? [normalized] : [];
        })
        .slice(0, this.#resultLimit),
    };
  }
}

export class PerplexityWebSearchProvider implements WebSearchProvider {
  readonly tool = providerTool("perplexity", "Perplexity");
  readonly #apiKey: string;
  readonly #resultLimit: number;

  constructor(apiKey: string, resultLimit = DEFAULT_RESULT_LIMIT) {
    this.#apiKey = apiKey;
    this.#resultLimit = resultLimit;
  }

  async search(
    input: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input);
    const payload = perplexitySchema.parse(
      await fetchJson(
        new URL("https://api.perplexity.ai/search"),
        jsonRequest(
          {
            query,
            max_results: this.#resultLimit,
            max_tokens_per_page: 1_024,
          },
          { authorization: `Bearer ${this.#apiKey}` },
        ),
        signal,
      ),
    );
    return {
      query,
      results: payload.results
        .flatMap((result) => {
          const normalized = safeResult(
            result.title,
            result.url,
            result.snippet,
            result.date ?? result.last_updated,
          );
          return normalized ? [normalized] : [];
        })
        .slice(0, this.#resultLimit),
    };
  }
}

export class FirecrawlWebSearchProvider implements WebSearchProvider {
  readonly tool = providerTool("firecrawl", "Firecrawl");
  readonly #apiKey: string;
  readonly #resultLimit: number;

  constructor(apiKey: string, resultLimit = DEFAULT_RESULT_LIMIT) {
    this.#apiKey = apiKey;
    this.#resultLimit = resultLimit;
  }

  async search(
    input: string,
    signal?: AbortSignal,
  ): Promise<WebSearchResponse> {
    const query = searchQuery(input);
    const payload = firecrawlSchema.parse(
      await fetchJson(
        new URL("https://api.firecrawl.dev/v2/search"),
        jsonRequest(
          {
            query,
            limit: this.#resultLimit,
            highlights: false,
          },
          { authorization: `Bearer ${this.#apiKey}` },
        ),
        signal,
      ),
    );
    return {
      query,
      results: (payload.data?.web ?? [])
        .flatMap((result) => {
          const normalized = safeResult(
            result.title,
            result.url,
            result.description ?? result.markdown,
          );
          return normalized ? [normalized] : [];
        })
        .slice(0, this.#resultLimit),
    };
  }
}

function apiKeySource(
  provider: KeyedWebSearchProviderId,
  bootstrap: WebSearchConfig,
  sessionApiKeys: Partial<Record<KeyedWebSearchProviderId, string>>,
): WebSearchProviderSettingsView["configurationSource"] {
  if (sessionApiKeys[provider]) return "session";
  if (bootstrap.apiKeys[provider]) return "environment";
  return undefined;
}

function searxngSource(
  bootstrap: WebSearchConfig,
  stored: StoredWebSearchSettings,
): WebSearchProviderSettingsView["configurationSource"] {
  if (stored.searxngBaseUrl) return "saved";
  if (bootstrap.searxngBaseUrl) return "environment";
  return undefined;
}

function failureDetail(error: unknown): string {
  if (!(error instanceof Error)) return "Provider request failed.";
  return compactText(error.message || "Provider request failed.", 240);
}

export function parseStoredWebSearchSettings(
  value: unknown,
): StoredWebSearchSettings {
  const parsed = storedSettingsSchema.parse(value);
  const searxngBaseUrl = parsed.searxngBaseUrl?.trim();
  return {
    ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.resultLimit === undefined
      ? {}
      : { resultLimit: parsed.resultLimit }),
    ...(searxngBaseUrl
      ? {
          searxngBaseUrl: normalizeSearchBaseUrl(
            searxngBaseUrl,
            "Saved SearXNG base URL",
          ),
        }
      : {}),
  };
}

export class ConfigurableWebSearchProvider implements WebSearchProvider {
  readonly #bootstrap: WebSearchConfig;
  #stored: StoredWebSearchSettings = {};
  #sessionApiKeys: Partial<Record<KeyedWebSearchProviderId, string>> = {};

  constructor(bootstrap?: WebSearchConfig) {
    this.#bootstrap = bootstrap ?? {
      enabled: true,
      provider: "auto",
      resultLimit: DEFAULT_RESULT_LIMIT,
      apiKeys: {},
    };
  }

  get tool(): RuntimeToolDescriptor {
    const settings = this.#effective();
    const selected = this.#definition(settings.provider);
    // Always "cloud", including a SearXNG on loopback.
    //
    // This used to report "local" when the SearXNG base URL was a loopback
    // address, which described where the instance LISTENS rather than where
    // the query GOES. SearXNG is a metasearch proxy: it forwards the query to
    // Google, Bing and friends, so the query leaves the device no matter where
    // the box sits. The descriptor's own `contextMayLeaveDevice: true` two
    // lines below always said so — one fact carried by two fields that
    // disagreed, with enforcement reading `location` and disclosure reading
    // the other.
    //
    // That was not cosmetic. `policies.ts` suggests tightening `private`'s
    // toolCeiling from "none" to "local"; doing so would have admitted a
    // loopback SearXNG on the strength of this field, which would then proxy
    // the query to Google — the exact egress the tightening was meant to
    // prevent, while the disclosure honestly reported it left.
    //
    // Self-hosting a proxy is a real privacy gain (no API key tied to you, no
    // vendor query log) but it is not "the query stayed here", and this field
    // is the one that decides whether the query is permitted.
    const location = "cloud" as const;
    return {
      id: `web-search:${settings.provider}`,
      label:
        settings.provider === "auto"
          ? "Web search (Auto)"
          : selected?.label ?? "Web search",
      capabilities: ["web"],
      location,
      available:
        settings.enabled && this.#candidateIds(settings).length > 0,
      contextMayLeaveDevice: true,
    };
  }

  settings(): WebSearchSettingsView {
    const effective = this.#effective();
    const providers = PROVIDER_DEFINITIONS.map((definition) => {
      const configured = this.#isConfigured(definition.id, effective);
      const configurationSource =
        definition.requires === "api_key"
          ? apiKeySource(
              definition.id as KeyedWebSearchProviderId,
              this.#bootstrap,
              this.#sessionApiKeys,
            )
          : definition.requires === "base_url"
            ? searxngSource(this.#bootstrap, this.#stored)
            : undefined;
      return {
        ...definition,
        configured,
        ...(definition.requires !== "none"
          ? {
              environmentConfigured:
                definition.requires === "api_key"
                  ? Boolean(
                      this.#bootstrap.apiKeys[
                        definition.id as KeyedWebSearchProviderId
                      ],
                    )
                  : Boolean(this.#bootstrap.searxngBaseUrl),
            }
          : {}),
        ...(configurationSource ? { configurationSource } : {}),
      };
    });
    return {
      enabled: effective.enabled,
      provider: effective.provider,
      resultLimit: effective.resultLimit,
      available: this.tool.available,
      autoOrder: AUTO_PROVIDER_ORDER,
      providers,
      ...(effective.searxngBaseUrl
        ? { searxngBaseUrl: effective.searxngBaseUrl }
        : {}),
    };
  }

  storedSettings(): StoredWebSearchSettings {
    return { ...this.#stored };
  }

  configureStored(value: unknown): void {
    this.#stored = parseStoredWebSearchSettings(value);
  }

  previewUpdate(update: WebSearchSettingsUpdate): StoredWebSearchSettings {
    if (!WEB_SEARCH_PROVIDER_IDS.includes(update.provider)) {
      throw new Error("Unsupported web-search provider.");
    }
    if (
      !Number.isInteger(update.resultLimit) ||
      update.resultLimit < MIN_RESULTS ||
      update.resultLimit > MAX_RESULTS
    ) {
      throw new Error(
        `Web search result limit must be between ${MIN_RESULTS} and ${MAX_RESULTS}.`,
      );
    }
    const next: StoredWebSearchSettings = {
      ...this.#stored,
      enabled: update.enabled,
      provider: update.provider,
      resultLimit: update.resultLimit,
    };

    if (update.searxngBaseUrl !== undefined) {
      if (update.searxngBaseUrl === null || !update.searxngBaseUrl.trim()) {
        delete next.searxngBaseUrl;
      } else {
        next.searxngBaseUrl = normalizeSearchBaseUrl(
          update.searxngBaseUrl.trim(),
          "SearXNG base URL",
        );
      }
    }
    const sessionApiKeys = this.#updatedSessionApiKeys(update.apiKeys);

    const effective = this.#effective(next, sessionApiKeys);
    if (
      effective.enabled &&
      effective.provider !== "auto" &&
      !this.#isConfigured(effective.provider, effective)
    ) {
      const definition = this.#definition(effective.provider);
      throw new Error(
        `${definition?.label ?? effective.provider} is not configured.`,
      );
    }
    return parseStoredWebSearchSettings(next);
  }

  applySessionApiKeyUpdate(
    update: WebSearchSettingsUpdate["apiKeys"],
  ): void {
    this.#sessionApiKeys = this.#updatedSessionApiKeys(update);
  }

  async search(
    input: string,
    signal?: AbortSignal,
    onAttempt?: (
      attempt: WebSearchAttempt,
    ) => void | Promise<void>,
  ): Promise<WebSearchResponse> {
    const settings = this.#effective();
    if (!settings.enabled) {
      throw new Error("Web search is disabled in Settings.");
    }
    const candidateIds = this.#candidateIds(settings);
    if (candidateIds.length === 0) {
      throw new Error("The selected web-search provider is not configured.");
    }

    const attempts: WebSearchAttempt[] = [];
    const searchController = new AbortController();
    const forwardAbort = () => searchController.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    const autoTimer = settings.provider === "auto"
      ? setTimeout(() => searchController.abort(), SEARCH_TIMEOUT_MS)
      : undefined;
    const searchSignal = searchController.signal;

    try {
      for (const providerId of candidateIds) {
        if (signal?.aborted) {
          throw new WebSearchExecutionError(
            "Web search was cancelled.",
            attempts,
          );
        }
        if (searchController.signal.aborted) {
          throw new WebSearchExecutionError(
            `Automatic web search exceeded its ${SEARCH_TIMEOUT_MS / 1_000}-second limit.`,
            attempts,
          );
        }
        let provider: WebSearchProvider | undefined;
        try {
          provider = this.#createProvider(providerId, settings);
          await onAttempt?.({
            provider: provider.tool.label,
            status: "running",
          });
          const response = await provider.search(
            input,
            searchSignal,
            onAttempt,
          );
          if (response.results.length === 0) {
            throw new Error("Provider returned no usable sources.");
          }
          attempts.push({
            provider: provider.tool.label,
            status: "completed",
          });
          await onAttempt?.(attempts.at(-1)!);
          return {
            ...response,
            provider: provider.tool.label,
            attempts,
          };
        } catch (error) {
          const cancelledByUser = signal?.aborted === true;
          const reachedAutoDeadline =
            !cancelledByUser &&
            settings.provider === "auto" &&
            searchController.signal.aborted;
          const providerLabel =
            provider?.tool.label ??
            this.#definition(providerId)?.label ??
            providerId;
          const detail = cancelledByUser
            ? "Web search was cancelled."
            : reachedAutoDeadline
              ? `Automatic web search exceeded its ${SEARCH_TIMEOUT_MS / 1_000}-second limit.`
              : failureDetail(error);
          attempts.push({
            provider: providerLabel,
            status: "failed",
            detail,
          });
          await onAttempt?.(attempts.at(-1)!);
          if (cancelledByUser || reachedAutoDeadline) {
            throw new WebSearchExecutionError(detail, attempts);
          }
          if (settings.provider !== "auto") {
            throw new WebSearchExecutionError(
              `${providerLabel} search failed: ${detail}`,
              attempts,
            );
          }
        }
      }

      throw new WebSearchExecutionError(
        `Web search failed across ${attempts.map((attempt) => attempt.provider).join(", ")}.`,
        attempts,
      );
    } finally {
      if (autoTimer !== undefined) clearTimeout(autoTimer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  #effective(
    stored: StoredWebSearchSettings = this.#stored,
    sessionApiKeys: Partial<Record<KeyedWebSearchProviderId, string>> =
      this.#sessionApiKeys,
  ): EffectiveWebSearchSettings {
    return {
      enabled:
        this.#bootstrap.enabled && (stored.enabled ?? this.#bootstrap.enabled),
      provider: stored.provider ?? this.#bootstrap.provider,
      resultLimit: stored.resultLimit ?? this.#bootstrap.resultLimit,
      apiKeys: {
        ...this.#bootstrap.apiKeys,
        ...sessionApiKeys,
      },
      ...(stored.searxngBaseUrl ?? this.#bootstrap.searxngBaseUrl
        ? {
            searxngBaseUrl:
              stored.searxngBaseUrl ?? this.#bootstrap.searxngBaseUrl,
          }
        : {}),
    };
  }

  #updatedSessionApiKeys(
    update: WebSearchSettingsUpdate["apiKeys"],
  ): Partial<Record<KeyedWebSearchProviderId, string>> {
    const apiKeys = { ...this.#sessionApiKeys };
    if (!update) return apiKeys;
    for (const provider of KEYED_PROVIDER_IDS) {
      const value = update[provider];
      if (value === undefined) continue;
      if (value === null || !value.trim()) {
        delete apiKeys[provider];
        continue;
      }
      const trimmed = value.trim();
      if (trimmed.length > MAX_API_KEY_CHARACTERS) {
        throw new Error(`${provider} API key is too long.`);
      }
      apiKeys[provider] = trimmed;
    }
    return apiKeys;
  }

  #definition(
    provider: WebSearchProviderId,
  ): ProviderDefinition | undefined {
    return PROVIDER_DEFINITIONS.find(
      (definition) => definition.id === provider,
    );
  }

  #isConfigured(
    provider: Exclude<WebSearchProviderId, "auto">,
    settings: EffectiveWebSearchSettings,
  ): boolean {
    if (provider === "duckduckgo") return true;
    if (provider === "searxng") return Boolean(settings.searxngBaseUrl);
    return Boolean(settings.apiKeys[provider]);
  }

  #candidateIds(
    settings: EffectiveWebSearchSettings,
  ): Exclude<WebSearchProviderId, "auto">[] {
    if (settings.provider === "auto") {
      return AUTO_PROVIDER_ORDER.filter((provider) =>
        this.#isConfigured(provider, settings),
      );
    }
    return this.#isConfigured(settings.provider, settings)
      ? [settings.provider]
      : [];
  }

  #createProvider(
    provider: Exclude<WebSearchProviderId, "auto">,
    settings: EffectiveWebSearchSettings,
  ): WebSearchProvider {
    switch (provider) {
      case "duckduckgo":
        return new DuckDuckGoWebSearchProvider(settings.resultLimit);
      case "searxng":
        return new SearxngWebSearchProvider(
          settings.searxngBaseUrl!,
          settings.resultLimit,
        );
      case "exa":
        return new ExaWebSearchProvider(
          settings.apiKeys.exa!,
          settings.resultLimit,
        );
      case "perplexity":
        return new PerplexityWebSearchProvider(
          settings.apiKeys.perplexity!,
          settings.resultLimit,
        );
      case "tavily":
        return new TavilyWebSearchProvider(
          settings.apiKeys.tavily!,
          settings.resultLimit,
        );
      case "brave":
        return new BraveWebSearchProvider(
          settings.apiKeys.brave!,
          settings.resultLimit,
        );
      case "firecrawl":
        return new FirecrawlWebSearchProvider(
          settings.apiKeys.firecrawl!,
          settings.resultLimit,
        );
    }
  }
}
