import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OrchestrationEvent,
  Orchestrator,
  TaskPlan,
} from "@quorum/core";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import type { QuorumRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

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
