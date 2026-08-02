import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server";
import { AppConfig } from "./config";
import { QuorumRuntime } from "./runtime";

describe("API Authentication", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let config: AppConfig;
  let runtime: QuorumRuntime;
  const TEST_API_KEY = "test-api-key";

  beforeEach(async () => {
    config = {
      host: "127.0.0.1",
      port: 8787,
      logLevel: "silent",
      dataDirectory: "./var-test",
      quorumLocalApiKey: TEST_API_KEY,
      local: {
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "",
        transport: "ollama",
        models: [],
        promptAnalyzer: { name: "", contextWindow: 0 },
        warmOnStartup: false,
      },
      orchestrationMode: "route",
    };
    runtime = {
      localRuntime: { status: "ready", providers: [] },
      warmupStatus: { state: "idle" },
      cloudConfigured: false,
      webSearch: { configured: false, enabled: false },
      refreshLocalModels: vi.fn(),
      orchestrator: {
        models: [],
        run: vi.fn(async function* () {}),
      },
      webSearchProvider: undefined,
    };
    app = await buildServer(config, runtime);
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
    expect(response.json()).toEqual({
      message: "Unauthorized: Bearer token required.",
    });
  });

  it("should reject requests to /api/runtime with an invalid Bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: {
        authorization: "Bearer wrong-api-key",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ message: "Unauthorized: Invalid token." });
  });

  it("should allow requests to /api/runtime with a valid Bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime",
      headers: {
        authorization: `Bearer ${TEST_API_KEY}`,
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it("should not require authentication if quorumLocalApiKey is not set in config", async () => {
    await app.close();
    const unauthenticatedConfig: AppConfig = {
      ...config,
      quorumLocalApiKey: undefined, // Explicitly unset
    };
    const unauthenticatedApp = await buildServer(unauthenticatedConfig, runtime);
    await unauthenticatedApp.listen();

    const response = await unauthenticatedApp.inject({
      method: "GET",
      url: "/api/runtime",
    });
    expect(response.statusCode).toBe(200);
    await unauthenticatedApp.close();
  });
});