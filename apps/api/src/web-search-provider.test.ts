import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BraveWebSearchProvider,
  ConfigurableWebSearchProvider,
  DuckDuckGoWebSearchProvider,
  ExaWebSearchProvider,
  FirecrawlWebSearchProvider,
  PerplexityWebSearchProvider,
  SearxngWebSearchProvider,
  TavilyWebSearchProvider,
} from "./web-search-provider.js";

describe("web search providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("queries SearXNG's JSON API and keeps only bounded safe results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Primary result",
              url: "https://example.com/article",
              content: "A useful source.",
              publishedDate: "2026-07-29",
            },
            {
              title: "Unsafe result",
              url: "javascript:alert(1)",
              content: "Must not reach the model.",
            },
            {
              title: "Private result",
              url: "https://127.0.0.1/admin",
              content: "Must not become a clickable source.",
            },
            {
              title: "Rebinding-style result",
              url: "https://127.0.0.1.nip.io/admin",
              content: "Must not become a clickable source.",
            },
            {
              title: "Plain HTTP result",
              url: "http://example.net/article",
              content: "Must use a secure destination.",
            },
            {
              title: "Trailing localhost",
              url: "https://localhost./admin",
              content: "Must not become a clickable source.",
            },
            {
              title: "Trailing local domain",
              url: "https://printer.local./admin",
              content: "Must not become a clickable source.",
            },
            {
              title: "IPv6 multicast",
              url: "https://[ff02::1]/",
              content: "Must not become a clickable source.",
            },
            {
              title: "Documentation address",
              url: "https://198.51.100.1/",
              content: "Must not become a clickable source.",
            },
            ...Array.from({ length: 7 }, (_, index) => ({
              title: `Extra ${index}`,
              url: `https://example.org/${index}`,
              content: `Snippet ${index}`,
            })),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new SearxngWebSearchProvider(
      "http://127.0.0.1:8080",
    );
    const result = await provider.search("latest Quorum release");

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.origin).toBe("http://127.0.0.1:8080");
    expect(requestUrl.pathname).toBe("/search");
    expect(requestUrl.searchParams.get("q")).toBe("latest Quorum release");
    expect(requestUrl.searchParams.get("format")).toBe("json");
    expect(result.query).toBe("latest Quorum release");
    expect(result.results).toHaveLength(5);
    expect(result.results[0]).toEqual({
      title: "Primary result",
      url: "https://example.com/article",
      snippet: "A useful source.",
      publishedAt: "2026-07-29",
    });
    expect(result.results.map((entry) => entry.title)).not.toContain(
      "Unsafe result",
    );
    expect(result.results.map((entry) => entry.title)).not.toContain(
      "Private result",
    );
    expect(result.results.map((entry) => entry.title)).not.toContain(
      "Rebinding-style result",
    );
    expect(result.results.map((entry) => entry.title)).not.toContain(
      "Plain HTTP result",
    );
    expect(result.results.map((entry) => entry.title)).not.toContain(
      "Trailing localhost",
    );
    expect(result.results.map((entry) => entry.title)).not.toContain(
      "Trailing local domain",
    );
    expect(result.results.map((entry) => entry.title)).not.toContain(
      "IPv6 multicast",
    );
    expect(result.results.map((entry) => entry.title)).not.toContain(
      "Documentation address",
    );
  });

  it("uses Brave's authenticated HTTPS endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: "Brave result",
                url: "https://example.com/brave",
                description: "Current information.",
                age: "1 hour ago",
              },
            ],
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new BraveWebSearchProvider("secret").search(
      "current information",
    );

    const [requestUrl, request] = fetchMock.mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(String(requestUrl)).toContain(
      "https://api.search.brave.com/res/v1/web/search",
    );
    expect(request.headers).toMatchObject({
      "x-subscription-token": "secret",
    });
    expect(request.redirect).toBe("error");
    expect(result.results).toEqual([
      {
        title: "Brave result",
        url: "https://example.com/brave",
        snippet: "Current information.",
        publishedAt: "1 hour ago",
      },
    ]);
  });

  it("surfaces provider HTTP failures without invoking a model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })),
    );

    await expect(
      new BraveWebSearchProvider("secret").search("current information"),
    ).rejects.toThrow("Web search returned HTTP 429");
  });

  it("provides bounded keyless DuckDuckGo results and unwraps redirect URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(`
        <html><body>
          <div class="result results_links web-result">
            <h2>
              <a class="result__a"
                 href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Frelease">
                Quorum &amp; search
              </a>
            </h2>
            <a class="result__snippet">A current &lt;release&gt; result.</a>
          </div>
        </body></html>
      `),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DuckDuckGoWebSearchProvider().search(
      "latest Quorum release",
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "https://html.duckduckgo.com/html/",
    );
    expect(result.results).toEqual([
      {
        title: "Quorum & search",
        url: "https://example.com/release",
        snippet: "A current <release> result.",
      },
    ]);
  });

  it.each([
    {
      name: "Tavily",
      provider: () => new TavilyWebSearchProvider("secret"),
      response: {
        results: [
          {
            title: "Tavily result",
            url: "https://example.com/tavily",
            content: "Grounding content.",
          },
        ],
      },
      endpoint: "https://api.tavily.com/search",
    },
    {
      name: "Exa",
      provider: () => new ExaWebSearchProvider("secret"),
      response: {
        results: [
          {
            title: "Exa result",
            url: "https://example.com/exa",
            text: "Extracted text.",
          },
        ],
      },
      endpoint: "https://api.exa.ai/search",
    },
    {
      name: "Perplexity",
      provider: () => new PerplexityWebSearchProvider("secret"),
      response: {
        results: [
          {
            title: "Perplexity result",
            url: "https://example.com/perplexity",
            snippet: "Ranked result.",
          },
        ],
      },
      endpoint: "https://api.perplexity.ai/search",
    },
    {
      name: "Firecrawl",
      provider: () => new FirecrawlWebSearchProvider("secret"),
      response: {
        data: {
          web: [
            {
              title: "Firecrawl result",
              url: "https://example.com/firecrawl",
              description: "Clean description.",
            },
          ],
        },
      },
      endpoint: "https://api.firecrawl.dev/v2/search",
    },
  ])("normalizes $name API results", async ({ provider, response, endpoint }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().search("current information");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(endpoint);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toContain("https://example.com/");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(String(request.body)).toContain("current information");
  });

  it("uses Open WebUI's provider order and records an Auto fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(`
          <div class="result results_links">
            <a class="result__a" href="https://example.com/fallback">
              Fallback result
            </a>
            <a class="result__snippet">DuckDuckGo answered.</a>
          </div>
        `),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: { exa: "configured" },
    });

    const result = await provider.search("latest release");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.exa.ai/search",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "https://html.duckduckgo.com/html/",
    );
    expect(result.provider).toBe("DuckDuckGo");
    expect(result.attempts).toEqual([
      {
        provider: "Exa",
        status: "failed",
        detail: "Web search returned HTTP 503.",
      },
      {
        provider: "DuckDuckGo",
        status: "completed",
      },
    ]);
  });

  it("does not silently fall back when a specific provider is selected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      provider: "exa",
      resultLimit: 5,
      apiKeys: { exa: "configured" },
    });

    await expect(provider.search("latest release")).rejects.toMatchObject({
      message: expect.stringContaining("Exa search failed"),
      attempts: [
        expect.objectContaining({
          provider: "Exa",
          status: "failed",
        }),
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps session credentials out of stored settings and settings responses", () => {
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: { brave: "environment-secret" },
    });
    const next = provider.previewUpdate({
      enabled: true,
      provider: "exa",
      resultLimit: 8,
      apiKeys: { exa: "saved-secret" },
    });
    provider.configureStored(next);
    provider.applySessionApiKeyUpdate({ exa: "session-secret" });

    const view = provider.settings();
    expect(
      view.providers.find((candidate) => candidate.id === "exa"),
    ).toMatchObject({
      configured: true,
      configurationSource: "session",
    });
    expect(
      view.providers.find((candidate) => candidate.id === "brave"),
    ).toMatchObject({
      configured: true,
      configurationSource: "environment",
    });
    expect(JSON.stringify(view)).not.toContain("session-secret");
    expect(JSON.stringify(view)).not.toContain("environment-secret");
    expect(JSON.stringify(provider.storedSettings())).not.toContain("secret");
  });

  it("keeps an environment search kill switch authoritative over stored settings", async () => {
    const provider = new ConfigurableWebSearchProvider({
      enabled: false,
      provider: "auto",
      resultLimit: 5,
      apiKeys: {},
    });
    provider.configureStored({
      enabled: true,
      provider: "duckduckgo",
      resultLimit: 5,
    });

    expect(provider.settings().enabled).toBe(false);
    await expect(provider.search("must stay offline")).rejects.toThrow(
      "disabled",
    );
  });

  it("records a bad provider configuration and continues Auto fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(`
        <div class="result results_links">
          <a class="result__a" href="https://example.com/fallback">Fallback</a>
          <a class="result__snippet">Safe fallback result.</a>
        </div>
      `),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: {},
      searxngBaseUrl: "https://remote.example.com",
    });

    const response = await provider.search("fallback query");

    expect(response.provider).toBe("DuckDuckGo");
    expect(response.attempts).toEqual([
      expect.objectContaining({ provider: "SearXNG", status: "failed" }),
      expect.objectContaining({ provider: "DuckDuckGo", status: "completed" }),
    ]);
  });

  it("accepts loopback SearXNG but rejects all remote targets", () => {
    const provider = new ConfigurableWebSearchProvider();
    expect(() =>
      provider.previewUpdate({
        enabled: true,
        provider: "searxng",
        resultLimit: 5,
        searxngBaseUrl: "http://127.0.0.1:8080",
      }),
    ).not.toThrow();
    expect(() =>
      provider.previewUpdate({
        enabled: true,
        provider: "searxng",
        resultLimit: 5,
        searxngBaseUrl: "https://search.example.org",
      }),
    ).toThrow("explicit loopback hostname");
    expect(() =>
      provider.previewUpdate({
        enabled: true,
        provider: "searxng",
        resultLimit: 5,
        searxngBaseUrl: "https://127.0.0.1.nip.io:8443",
      }),
    ).toThrow("explicit loopback hostname");
    expect(() =>
      provider.previewUpdate({
        enabled: true,
        provider: "searxng",
        resultLimit: 5,
        searxngBaseUrl: "http://192.168.1.10:8080",
      }),
    ).toThrow("explicit loopback hostname");
  });

  it("preserves all failed Auto attempts in a structured error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    );
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: { exa: "configured" },
    });

    await expect(provider.search("latest release")).rejects.toMatchObject({
      name: "WebSearchExecutionError",
      attempts: [
        expect.objectContaining({ provider: "Exa", status: "failed" }),
        expect.objectContaining({
          provider: "DuckDuckGo",
          status: "failed",
        }),
      ],
    });
  });

  it("uses one eight-second deadline across every Auto provider", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: URL | string, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((resolve) => {
            setTimeout(
              () => resolve(new Response("unavailable", { status: 503 })),
              5_000,
            );
          });
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: {
        exa: "configured",
        perplexity: "configured",
      },
    });

    const assertion = expect(
      provider.search("latest release"),
    ).rejects.toMatchObject({
      message: "Automatic web search exceeded its 8-second limit.",
      attempts: [
        expect.objectContaining({ provider: "Exa", status: "failed" }),
        expect.objectContaining({
          provider: "Perplexity",
          status: "failed",
          detail: "Automatic web search exceeded its 8-second limit.",
        }),
      ],
    });
    await vi.advanceTimersByTimeAsync(8_001);
    await assertion;
    expect(calls).toBe(2);
  });

  it("preserves the active recipient when a search is cancelled", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: URL | string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: { exa: "configured" },
    });

    const assertion = expect(
      provider.search("latest release", controller.signal),
    ).rejects.toMatchObject({
      message: "Web search was cancelled.",
      attempts: [
        {
          provider: "Exa",
          status: "failed",
          detail: "Web search was cancelled.",
        },
      ],
    });
    controller.abort();
    await assertion;
  });

  it("bounds Brave queries to its 400-character and 50-word limits", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ web: { results: [] } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new BraveWebSearchProvider("configured");

    await provider.search(
      Array.from({ length: 80 }, (_, index) => `term-${index}`).join(" "),
    );

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    const query = url.searchParams.get("q") ?? "";
    expect(query.length).toBeLessThanOrEqual(400);
    expect(query.split(/\s+/u)).toHaveLength(50);
  });

  it("falls back to an environment key when a session key is removed", () => {
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      provider: "exa",
      resultLimit: 5,
      apiKeys: { exa: "environment-secret" },
    });
    provider.applySessionApiKeyUpdate({ exa: "session-secret" });
    provider.applySessionApiKeyUpdate({ exa: null });

    expect(
      provider.settings().providers.find((candidate) => candidate.id === "exa"),
    ).toMatchObject({
      configured: true,
      configurationSource: "environment",
      environmentConfigured: true,
    });
  });
});
