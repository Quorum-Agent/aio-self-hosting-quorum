import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BraveWebSearchProvider,
  SearxngWebSearchProvider,
} from "./web-search-provider.js";

describe("web search providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
