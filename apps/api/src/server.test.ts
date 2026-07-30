import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OrchestrationEvent,
  Orchestrator,
  TaskPlan,
} from "@quorum/core";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import { QuorumDatabase } from "./database.js";
import type { QuorumRuntime } from "./runtime.js";
import { buildServer } from "./server.js";
import { ConfigurableWebSearchProvider } from "./web-search-provider.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("chat execution persistence", () => {
  it("persists a write-ahead web audit when orchestration throws after planning", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "quorum-server-"));
    temporaryDirectories.push(dataDirectory);
    const plan: TaskPlan = {
      id: "plan-1",
      requestId: "request-1",
      policy: "balanced",
      verbosity: "standard",
      analysis: {
        source: "heuristic",
        intent: "research",
        confidence: 0.98,
        taskSummary: "Research the latest release.",
      },
      route: "local",
      modelId: "local:test",
      rationale: "Search before local reasoning.",
      steps: [
        {
          id: "search-step",
          label: "Search the web with Test Search",
          kind: "retrieval",
          location: "cloud",
        },
      ],
      webSearch: {
        provider: "Test Search",
        query: "Research the latest release.",
        contextMayHaveLeftDevice: true,
        sources: [],
      },
    };
    const orchestrator = {
      models: [],
      async *run(): AsyncGenerator<OrchestrationEvent> {
        yield { type: "plan", plan };
        throw new Error("Web search returned HTTP 429.");
      },
    } as unknown as Orchestrator;
    const warmupStatus: QuorumRuntime["warmupStatus"] = {
      state: "disabled",
      models: [],
    };
    const runtime: QuorumRuntime = {
      orchestrator,
      localRuntime: {
        state: "unavailable",
        endpointConnected: false,
        roles: [],
      },
      cloudConfigured: false,
      warmupStatus,
      warmup: Promise.resolve(warmupStatus),
      async refreshLocalModels() {},
    };
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 8787,
      logLevel: "silent",
      dataDirectory,
      local: {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        models: [],
        promptAnalyzer: {
          name: "classifier",
          contextWindow: 4_096,
        },
        warmOnStartup: false,
      },
    };
    const app = await buildServer(config, runtime);

    await app.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: "conversation-1",
        policy: "balanced",
        verbosity: "standard",
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Research the latest release.",
            createdAt: new Date(0).toISOString(),
          },
        ],
      },
    });
    const history = await app.inject({
      method: "GET",
      url: "/api/conversations/conversation-1/messages",
    });
    const messages = history.json<{ messages: Array<{
      role: string;
      content: string;
      execution?: { plan: TaskPlan };
    }> }>().messages;

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Request failed: Web search returned HTTP 429.",
      execution: {
        plan: {
          webSearch: {
            provider: "Test Search",
            contextMayHaveLeftDevice: true,
          },
        },
      },
    });
    await app.close();
  });
});

describe("conversation lifecycle routes", () => {
  it("renames, exports, and deletes a conversation through the API", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "quorum-lifecycle-"));
    temporaryDirectories.push(dataDirectory);
    const warmupStatus: QuorumRuntime["warmupStatus"] = {
      state: "disabled",
      models: [],
    };
    const runtime: QuorumRuntime = {
      orchestrator: { models: [] } as unknown as Orchestrator,
      localRuntime: {
        state: "unavailable",
        endpointConnected: false,
        roles: [],
      },
      cloudConfigured: false,
      warmupStatus,
      warmup: Promise.resolve(warmupStatus),
      async refreshLocalModels() {},
    };
    const app = await buildServer(
      {
        host: "127.0.0.1",
        port: 8787,
        logLevel: "silent",
        dataDirectory,
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: "ollama",
          models: [],
          promptAnalyzer: {
            name: "classifier",
            contextWindow: 4_096,
          },
          warmOnStartup: false,
        },
      },
      runtime,
    );

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/conversations",
          payload: { id: "conversation-1", title: "Original" },
        })
      ).statusCode,
    ).toBe(201);
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/conversations/conversation-1",
      payload: { title: "Renamed conversation" },
    });
    expect(renamed.json().conversation.title).toBe("Renamed conversation");

    const exported = await app.inject({
      method: "GET",
      url: "/api/conversations/conversation-1/export",
    });
    expect(exported.headers["content-disposition"]).toContain(
      "Renamed-conversation.json",
    );
    expect(exported.json().conversation.id).toBe("conversation-1");

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/conversations/conversation-1",
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/conversations/conversation-1/messages",
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});

describe("web-search settings", () => {
  function runtimeWithSearch(
    provider: ConfigurableWebSearchProvider,
  ): QuorumRuntime {
    const warmupStatus: QuorumRuntime["warmupStatus"] = {
      state: "disabled",
      models: [],
    };
    return {
      orchestrator: {
        models: [],
      } as unknown as Orchestrator,
      localRuntime: {
        state: "unavailable",
        endpointConnected: false,
        roles: [],
      },
      cloudConfigured: false,
      get webSearch() {
        return provider.tool;
      },
      webSearchProvider: provider,
      warmupStatus,
      warmup: Promise.resolve(warmupStatus),
      async refreshLocalModels() {},
    };
  }

  function configFor(dataDirectory: string): AppConfig {
    return {
      host: "127.0.0.1",
      port: 8787,
      logLevel: "silent",
      dataDirectory,
      local: {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        models: [],
        promptAnalyzer: {
          name: "classifier",
          contextWindow: 4_096,
        },
        warmOnStartup: false,
      },
    };
  }

  it("keeps keys session-only while reloading non-secret settings", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "quorum-server-"));
    temporaryDirectories.push(dataDirectory);
    const firstProvider = new ConfigurableWebSearchProvider();
    const app = await buildServer(
      configFor(dataDirectory),
      runtimeWithSearch(firstProvider),
    );

    const initial = await app.inject({
      method: "GET",
      url: "/api/settings/web-search",
    });
    expect(initial.json()).toMatchObject({
      settings: {
        enabled: true,
        provider: "auto",
        available: true,
      },
    });

    const updated = await app.inject({
      method: "PUT",
      url: "/api/settings/web-search",
      payload: {
        enabled: true,
        provider: "exa",
        resultLimit: 8,
        apiKeys: { exa: "session-secret" },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain("session-secret");
    expect(updated.json()).toMatchObject({
      settings: {
        provider: "exa",
        resultLimit: 8,
        available: true,
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "exa",
            configured: true,
            configurationSource: "session",
          }),
        ]),
      },
    });
    await app.close();
    expect(
      (await import("node:fs")).readFileSync(
        join(dataDirectory, "quorum.db"),
      ).toString("latin1"),
    ).not.toContain("session-secret");

    const reopenedProvider = new ConfigurableWebSearchProvider();
    const reopened = await buildServer(
      configFor(dataDirectory),
      runtimeWithSearch(reopenedProvider),
    );
    expect(reopenedProvider.settings()).toMatchObject({
      provider: "exa",
      resultLimit: 8,
      available: false,
    });
    expect(JSON.stringify(reopenedProvider.settings())).not.toContain(
      "session-secret",
    );
    await reopened.close();
  });

  it("rejects non-loopback hosts and browser origins", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "quorum-server-"));
    temporaryDirectories.push(dataDirectory);
    const app = await buildServer(
      configFor(dataDirectory),
      runtimeWithSearch(new ConfigurableWebSearchProvider()),
    );

    const badHost = await app.inject({
      method: "GET",
      url: "/api/settings/web-search",
      headers: { host: "evil.example:8787" },
    });
    expect(badHost.statusCode).toBe(403);
    const rebindingHost = await app.inject({
      method: "GET",
      url: "/api/settings/web-search",
      headers: { host: "127.0.0.1.nip.io:8787" },
    });
    expect(rebindingHost.statusCode).toBe(403);

    const badOrigin = await app.inject({
      method: "PUT",
      url: "/api/settings/web-search",
      headers: { origin: "https://evil.example" },
      payload: {
        enabled: true,
        provider: "auto",
        resultLimit: 5,
      },
    });
    expect(badOrigin.statusCode).toBe(403);

    await app.close();
  });

  it("purges API keys left by a legacy settings row", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "quorum-server-"));
    temporaryDirectories.push(dataDirectory);
    const legacySecret = `legacy-${"x".repeat(4_000)}`;
    const database = new QuorumDatabase(dataDirectory);
    database.setSetting("web_search", {
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: { exa: legacySecret },
    });
    database.close();

    const app = await buildServer(
      configFor(dataDirectory),
      runtimeWithSearch(new ConfigurableWebSearchProvider()),
    );
    await app.close();

    const databaseArtifacts = [
      "quorum.db",
      "quorum.db-wal",
      "quorum.db-shm",
    ]
      .map((name) => join(dataDirectory, name))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path).toString("latin1"))
      .join("");
    expect(databaseArtifacts).not.toContain(legacySecret);
  });

  it("rejects selecting an unconfigured provider", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "quorum-server-"));
    temporaryDirectories.push(dataDirectory);
    const app = await buildServer(
      configFor(dataDirectory),
      runtimeWithSearch(new ConfigurableWebSearchProvider()),
    );

    const response = await app.inject({
      method: "PUT",
      url: "/api/settings/web-search",
      payload: {
        enabled: true,
        provider: "perplexity",
        resultLimit: 5,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      message: "Perplexity is not configured.",
    });
    await app.close();
  });
});
