import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.js";
import type { Capability } from "@quorum/core";

import {
  createLocalProviders,
  describeCapabilityAdjustments,
  createRuntime,
  currentLocalRuntime,
  describeLocalRuntime,
} from "./runtime.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 8787,
  logLevel: "silent",
  dataDirectory: "test-data",
  local: {
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    transport: "ollama",
    promptAnalyzer: {
      name: "classifier",
      contextWindow: 4_096,
    },
    warmOnStartup: true,
    models: [
      {
        role: "general",
        name: "general",
        capabilities: ["chat", "reasoning", "coding"],
        specialties: [],
        contextWindow: 32_000,
        qualityRating: 60,
      },
      {
        role: "coding",
        name: "code",
        capabilities: ["chat", "coding"],
        specialties: ["coding"],
        contextWindow: 32_000,
        qualityRating: 50,
      },
      {
        role: "reasoning",
        name: "reasoning",
        capabilities: ["chat", "reasoning"],
        specialties: ["reasoning"],
        contextWindow: 128_000,
        qualityRating: 55,
        reasoningEffort: "none",
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLocalProviders", () => {
  it("registers only installed configured experts", () => {
    const providers = createLocalProviders(config, ["general", "code"]);

    expect(providers.map((provider) => provider.model)).toEqual([
      expect.objectContaining({
        id: "local:general:general",
        role: "general",
        specialties: [],
      }),
      expect.objectContaining({
        id: "local:coding:code",
        role: "coding",
        capabilities: ["chat", "coding"],
        specialties: ["coding"],
      }),
    ]);
  });

  it("registers no phantom provider for a missing model", () => {
    expect(createLocalProviders(config, [])).toEqual([]);
  });

  it("matches an omitted configured tag to Ollama's explicit latest tag", () => {
    const providers = createLocalProviders(config, [
      "general:latest",
      "code:latest",
    ]);

    expect(providers.map((provider) => provider.model.role)).toEqual([
      "general",
      "coding",
    ]);
  });

  // The managed llama.cpp path has two gates that disagreed about case:
  // waitUntilReady lowercases both sides before comparing catalogue IDs, while
  // this check compared exactly. An uppercase manifest ID passed startup and
  // then failed discovery, leaving the runtime degraded with the UI blaming a
  // missing model.
  it("matches a configured model whose catalogue spelling differs in case", () => {
    const providers = createLocalProviders(config, ["General", "CODE"]);

    expect(providers.map((provider) => provider.model.role)).toEqual([
      "general",
      "coding",
    ]);
  });

  it("is ready only when every configured role is available", () => {
    const providers = createLocalProviders(config, ["general", "code", "reasoning"]);

    expect(describeLocalRuntime(config, true, providers, true)).toMatchObject({
      state: "ready",
      endpointConnected: true,
      roles: [
        { role: "general", required: true, available: true },
        { role: "coding", required: false, available: true },
        { role: "reasoning", required: false, available: true },
      ],
      promptAnalyzer: {
        configuredModel: "classifier",
        available: true,
      },
    });
  });

  it("reports degraded instead of ready when the general role is missing", () => {
    const providers = createLocalProviders(config, ["code", "reasoning"]);

    expect(describeLocalRuntime(config, true, providers, true)).toMatchObject({
      state: "degraded",
      endpointConnected: true,
      roles: [
        { role: "general", available: false },
        { role: "coding", available: true },
        { role: "reasoning", available: true },
      ],
    });
  });

  it("reports an unavailable endpoint separately from missing models", () => {
    expect(describeLocalRuntime(config, false, [], false)).toMatchObject({
      state: "unavailable",
      endpointConnected: false,
    });
  });

  it("derives current role health from circuit-aware model availability", () => {
    const providers = createLocalProviders(config, ["general", "code", "reasoning"]);
    const discovered = describeLocalRuntime(config, true, providers, true);
    const current = currentLocalRuntime(
      discovered,
      providers.map((provider) =>
        provider.model.role === "coding"
          ? { ...provider.model, available: false }
          : provider.model,
      ),
    );

    expect(current).toMatchObject({
      state: "degraded",
      roles: [
        { role: "general", available: true },
        { role: "coding", available: false },
        { role: "reasoning", available: true },
      ],
    });
  });

  it("reports a missing prompt analyzer as degraded without inventing a provider", () => {
    const providers = createLocalProviders(config, [
      "general",
      "code",
      "reasoning",
    ]);

    expect(describeLocalRuntime(config, true, providers, false)).toMatchObject({
      state: "degraded",
      promptAnalyzer: {
        configuredModel: "classifier",
        available: false,
      },
    });
  });

  it("discovers every configured role when the model server starts after Quorum", async () => {
    let online = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        online
          ? new Response(
              JSON.stringify({
                data: [
                  { id: "classifier" },
                  { id: "general" },
                  { id: "code" },
                  { id: "reasoning" },
                ],
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            )
          : new Response("not ready", { status: 503 }),
      ),
    );
    const runtime = await createRuntime({
      ...config,
      local: { ...config.local, warmOnStartup: false },
    });

    expect(runtime.localRuntime.state).toBe("unavailable");
    online = true;
    await runtime.refreshLocalModels();

    expect(runtime.localRuntime).toMatchObject({
      state: "ready",
      endpointConnected: true,
      roles: [
        { role: "general", available: true },
        { role: "coding", available: true },
        { role: "reasoning", available: true },
      ],
      promptAnalyzer: { available: true },
    });
  });
});

describe("a local runtime that cannot serve says why", () => {
  const problem = {
    summary:
      "The managed llama.cpp runtime did not start, so no local model is being served.",
    detail:
      "Managed llama.cpp exited with code 1. error loading model hyperparameters: key qwen35.rope.dimension_sections has wrong array length; expected 4, got 3",
  };

  it("carries the cause the startup path already caught", () => {
    expect(describeLocalRuntime(config, false, [], false, problem)).toMatchObject(
      { state: "unavailable", problem },
    );
  });

  it("claims nothing when nothing knows a cause", () => {
    expect(describeLocalRuntime(config, false, [], false).problem).toBeUndefined();
  });

  // The status is rebuilt on every poll and every chat dispatch. Dropping the
  // cause here would show it once, on the first read after startup, and then
  // silently lose it — leaving an operator who saw the reason unable to find it
  // again. The fixture keeps the endpoint disconnected so the surviving field
  // is the only difference between the two shapes.
  it("keeps the cause across a status refresh", () => {
    const discovered = describeLocalRuntime(config, false, [], false, problem);
    expect(currentLocalRuntime(discovered, []).problem).toEqual(problem);
  });

  it("does not invent a cause when the discovered status had none", () => {
    const discovered = describeLocalRuntime(config, false, [], false);
    expect(currentLocalRuntime(discovered, []).problem).toBeUndefined();
  });
});

describe("capabilities the runtime decided rather than config", () => {
  const probed = new Map<string, Capability[]>([["general", ["vision"]]]);

  it("builds the provider with what the runtime reported", () => {
    const [provider] = createLocalProviders(
      config,
      ["general"],
      undefined,
      probed,
    );
    expect(provider?.model.capabilities).toContain("vision");
  });

  // The fixture matters: `config`'s general model declares chat/reasoning/
  // coding and no vision, and the probe reports vision and no tools. So a
  // reconciliation that ignored the runtime, ignored config, or applied the
  // runtime to every capability would each produce a different answer here.
  it("records both directions of the change, and nothing else", () => {
    expect(describeCapabilityAdjustments(config, ["general"], probed)).toEqual([
      { model: "general", added: ["vision"], removed: [] },
    ]);
  });

  it("records nothing for a model the runtime could not be asked about", () => {
    expect(describeCapabilityAdjustments(config, ["general"], new Map())).toEqual(
      [],
    );
  });

  it("puts the adjustments on the status the client reads", () => {
    const providers = createLocalProviders(config, ["general"], undefined, probed);
    const status = describeLocalRuntime(
      config,
      true,
      providers,
      true,
      undefined,
      probed,
    );
    expect(status.capabilityAdjustments).toEqual([
      { model: "general", added: ["vision"], removed: [] },
    ]);
  });

  // Same argument as the failure cause beside it: the status is rebuilt on
  // every poll, so an adjustment that survived only the first read would leave
  // an operator who saw the explanation unable to find it again.
  it("keeps them across a status refresh", () => {
    const providers = createLocalProviders(config, ["general"], undefined, probed);
    const discovered = describeLocalRuntime(
      config,
      true,
      providers,
      true,
      undefined,
      probed,
    );
    expect(
      currentLocalRuntime(
        discovered,
        providers.map((provider) => provider.model),
      ).capabilityAdjustments,
    ).toEqual([{ model: "general", added: ["vision"], removed: [] }]);
  });

  it("says nothing at all when the runtime agrees", () => {
    const agreeing = new Map<string, Capability[]>([["general", []]]);
    const providers = createLocalProviders(config, ["general"], undefined, agreeing);
    expect(
      describeLocalRuntime(
        config,
        true,
        providers,
        true,
        undefined,
        agreeing,
      ).capabilityAdjustments,
    ).toBeUndefined();
  });
});

describe("whether the runtime confirmed what a model can do", () => {
  it("marks a probed model as verified", () => {
    const probed = new Map<string, Capability[]>([["general", ["vision"]]]);
    const providers = createLocalProviders(config, ["general"], undefined, probed);
    const status = describeLocalRuntime(config, true, providers, true, undefined, probed);
    expect(status.roles[0]?.capabilityProvenance.confirmed).toEqual(["vision"]);
  });

  // The transport that cannot be asked. Being safe here is not the same as
  // being honest about it: the capability list is an assertion, and an asserted
  // `vision` routes an image to a model that cannot see it.
  it("marks a model behind a runtime that cannot be asked as unverified", () => {
    const providers = createLocalProviders(config, ["general"], undefined, new Map());
    const status = describeLocalRuntime(
      config,
      true,
      providers,
      true,
      undefined,
      new Map(),
    );
    expect(status.roles[0]?.capabilityProvenance.confirmed).toEqual([]);
  });

  it("keeps that provenance across a status refresh", () => {
    const probed = new Map<string, Capability[]>([["general", ["vision"]]]);
    const providers = createLocalProviders(config, ["general"], undefined, probed);
    const discovered = describeLocalRuntime(config, true, providers, true, undefined, probed);
    expect(
      currentLocalRuntime(
        discovered,
        providers.map((provider) => provider.model),
      ).roles[0]?.capabilityProvenance.confirmed,
    ).toEqual(["vision"]);
  });
});

describe("the durable record of a capability the runtime decided", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The visible half is tested above. This is the other half the operator was
  // promised: a structured record that survives the session, because a routing
  // change is the kind of thing someone investigates hours later from a log
  // rather than from a panel they no longer have open.
  it("hands each adjustment to the caller for logging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/show")) {
          return new Response(JSON.stringify({ capabilities: ["vision"] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "general" }, { id: "classifier" }] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const recorded: Array<{ model: string; added: Capability[] }> = [];
    await createRuntime(
      { ...config, local: { ...config.local, warmOnStartup: false } },
      {
        onCapabilityAdjustment: (adjustment) =>
          recorded.push({
            model: adjustment.model,
            added: adjustment.added,
          }),
      },
    );

    expect(recorded).toContainEqual({ model: "general", added: ["vision"] });
  });

  it("records nothing when the runtime agrees with the configuration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/show")) {
          return new Response(JSON.stringify({ capabilities: [] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "general" }, { id: "classifier" }] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const recorded: string[] = [];
    await createRuntime(
      { ...config, local: { ...config.local, warmOnStartup: false } },
      { onCapabilityAdjustment: (adjustment) => recorded.push(adjustment.model) },
    );

    expect(recorded).toEqual([]);
  });
});

describe("the durable warning that a capability was never confirmed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubOllama(showBody: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/show")) {
          return showBody === undefined
            ? new Response("nope", { status: 404 })
            : new Response(JSON.stringify(showBody), {
                headers: { "content-type": "application/json" },
              });
        }
        if (url.endsWith("/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "general" }, { id: "classifier" }] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("{}", {
          headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  // The riskier half of the disclosure, and the one that had no test until a
  // mutation removing the call changed nothing. A capability nothing confirmed
  // is still an eligibility filter the planner acts on.
  it("names a model whose capabilities nothing could confirm", async () => {
    stubOllama(undefined);
    const unconfirmed: Array<{ model: string; asserted: Capability[] }> = [];
    await createRuntime(
      { ...config, local: { ...config.local, warmOnStartup: false } },
      {
        onCapabilitiesUnconfirmed: (model, asserted) =>
          unconfirmed.push({ model, asserted }),
      },
    );
    expect(unconfirmed.map((entry) => entry.model)).toContain("general");
    expect(unconfirmed[0]?.asserted.length).toBeGreaterThan(0);
  });

  // The fixture that keeps it honest: a successful probe must NOT produce the
  // warning, or it would fire on every healthy startup and mean nothing.
  it("stays silent when the runtime answered", async () => {
    stubOllama({ capabilities: ["vision"] });
    const unconfirmed: string[] = [];
    await createRuntime(
      { ...config, local: { ...config.local, warmOnStartup: false } },
      { onCapabilitiesUnconfirmed: (model) => unconfirmed.push(model) },
    );
    expect(unconfirmed).toEqual([]);
  });
});

describe("re-asking the runtime once it is reachable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Finding #4 from review: the startup probe was one-shot. A model server that
  // starts after Quorum — the case `refreshLocalModels` exists for — would then
  // serve every request on config's word until the process restarted, with the
  // interface saying only that capabilities were unconfirmed and never
  // recovering. The fixture starts the endpoint offline so the first probe
  // cannot succeed, which is what makes the refresh the thing under test.
  it("probes capabilities on refresh, not only at startup", async () => {
    let online = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!online) return new Response("not ready", { status: 503 });
        if (url.endsWith("/api/show")) {
          return new Response(JSON.stringify({ capabilities: ["vision"] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            data: [
              { id: "classifier" },
              { id: "general" },
              { id: "code" },
              { id: "reasoning" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }),
    );

    const runtime = await createRuntime({
      ...config,
      local: { ...config.local, warmOnStartup: false },
    });
    expect(runtime.localRuntime.state).toBe("unavailable");

    online = true;
    await runtime.refreshLocalModels();

    expect(runtime.localRuntime.roles[0]?.capabilityProvenance.confirmed).toEqual(
      ["vision"],
    );
    expect(runtime.localRuntime.capabilityAdjustments).toContainEqual({
      model: "general",
      added: ["vision"],
      removed: [],
    });
  });
});
