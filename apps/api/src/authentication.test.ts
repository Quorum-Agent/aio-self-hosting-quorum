import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import type { AppConfig } from "./config.js";
import type { QuorumRuntime } from "./runtime.js";
import { timingSafeEqual } from "node:crypto";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    logLevel: "silent",
    dataDirectory: "./var-test",
    local: {
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      transport: "ollama",
      models: [],
      promptAnalyzer: { name: "", contextWindow: 0 },
      warmOnStartup: false,
    },
    orchestrationMode: "route",
    ...overrides,
  };
}

function makeRuntime(): QuorumRuntime {
  return {
    orchestrator: {
      models: [],
      run: vi.fn(async function* () {}),
    },
    localRuntime: { status: "ready", providers: [] },
    cloudConfigured: false,
    warmupStatus: { state: "idle", models: [] },
    warmup: Promise.resolve({ state: "idle", models: [] }),
    refreshLocalModels: vi.fn(),
  } as unknown as QuorumRuntime;
}

describe("API Authentication", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const TEST_API_KEY = "test-api-key";

  beforeEach(async () => {
    app = await buildServer(
      makeConfig({ quorumLocalApiKey: TEST_API_KEY }),
      makeRuntime(),
    );
    await app.listen();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  it("should allow access to /api/health without authentication", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect(response.statusCode).toBe(200);
  });

  it("should reject requests to /api/runtime without an Authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "Unauthorized: Bearer token required." });
  });

  it("should reject requests to /api/runtime with an invalid Bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: { authorization: "Bearer wrong-api-key" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "Unauthorized: Invalid token." });
  });

  it("should allow requests to /api/runtime with a valid Bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it("should reject requests to /api/runtime with a token of different length (timingSafeEqual)", async () => {
    const longInvalidToken = TEST_API_KEY + "extra";
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: { authorization: `Bearer ${longInvalidToken}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "Unauthorized: Invalid token." });
  });

  it("should not require authentication if quorumLocalApiKey is not set", async () => {
    const unauthenticatedApp = await buildServer(makeConfig(), makeRuntime());
    await unauthenticatedApp.listen();
    const response = await unauthenticatedApp.inject({
      method: "GET",
      url: "/api/runtime",
    });
    expect(response.statusCode).toBe(200);
    await unauthenticatedApp.close();
  });
});
