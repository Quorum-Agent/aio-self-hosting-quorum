import { afterEach, describe, expect, it, vi } from "vitest";

import type { Capability } from "@quorum/core";

import {
  DERIVED_CAPABILITIES,
  fetchOllamaCapabilities,
  mapRuntimeCapabilities,
  reconcileCapabilities,
  splitCapabilityProvenance,
} from "./runtime-capabilities.js";

/** What config stamps onto every local model today, regardless of the model. */
const DECLARED: Capability[] = ["chat", "reasoning", "coding", "documents"];

describe("translating what the runtime reports", () => {
  // Measured against the twenty models installed on the development machine.
  // These are the strings Ollama actually returns, not invented ones.
  it("keeps the two capabilities a runtime can answer definitively", () => {
    expect(
      mapRuntimeCapabilities(["completion", "vision", "tools", "thinking"]),
    ).toEqual(["vision", "tools"]);
  });

  // Each of these omissions is a decision, and each would misroute if reversed.
  it.each([
    // A thinking mode is not an aptitude. Mapping this would strip `reasoning`
    // from llama3.1:8b and mistral-nemo, which reason perfectly well without
    // one — and capabilities are hard filters, so that dead-ends the request
    // rather than degrading the answer.
    ["thinking", "reasoning"],
    // Fill-in-the-middle correlates with code models; it does not define them.
    ["insert", "coding"],
    // Everything reports it, so it discriminates nothing.
    ["completion", "chat"],
    // A route the product cannot serve. Declaring it would be the defect this
    // module exists to remove, pointed the other way.
    ["audio", "documents"],
  ] as const)("does not translate %s into %s", (reported, capability) => {
    expect(mapRuntimeCapabilities([reported])).not.toContain(capability);
  });

  it("ignores a capability name it does not know", () => {
    expect(mapRuntimeCapabilities(["something-new-in-a-later-release"])).toEqual(
      [],
    );
  });

  it("does not repeat a capability reported twice", () => {
    expect(mapRuntimeCapabilities(["vision", "vision"])).toEqual(["vision"]);
  });
});

describe("reconciling what config declared with what the runtime says", () => {
  // The measured case: qwen3.5:9b, ministral-3:8b and both gemma4 models
  // report vision, and Quorum could not route an image to any of them.
  it("adds a capability the model has and the configuration missed", () => {
    const result = reconcileCapabilities(DECLARED, ["vision", "tools"]);
    expect(result.added).toEqual(["vision", "tools"]);
    expect(result.removed).toEqual([]);
    expect(result.capabilities).toContain("vision");
    expect(result.capabilities).toContain("chat");
  });

  // The other measured case: phi4:14b-q4_K_M reports `completion` alone.
  it("removes a capability the configuration claimed and the model lacks", () => {
    const result = reconcileCapabilities([...DECLARED, "tools"], []);
    expect(result.removed).toEqual(["tools"]);
    expect(result.capabilities).not.toContain("tools");
  });

  // The distinction the whole module turns on. A runtime that cannot be asked
  // must not look like a runtime that answered "nothing" — llama.cpp has no
  // such endpoint, and treating its silence as an empty answer would strip
  // vision and tools from every model behind it.
  it("leaves the declaration untouched when nothing could be asked", () => {
    const declared: Capability[] = [...DECLARED, "vision", "tools"];
    const result = reconcileCapabilities(declared, undefined);
    expect(result).toEqual({
      capabilities: declared,
      added: [],
      removed: [],
    });
  });

  it("distinguishes that silence from an answer of none", () => {
    expect(reconcileCapabilities([...DECLARED, "vision"], []).removed).toEqual([
      "vision",
    ]);
  });

  // Anything the runtime does not report on is config's to declare. Dropping
  // it would be a routing change nobody asked for, and `coding` and
  // `documents` are exactly the capabilities no runtime answers.
  it("never touches a capability outside the derived set", () => {
    const result = reconcileCapabilities(DECLARED, []);
    for (const capability of DECLARED) {
      if (DERIVED_CAPABILITIES.includes(capability)) continue;
      expect(result.capabilities).toContain(capability);
    }
    expect(result.removed).toEqual([]);
  });

  it("reports nothing when the runtime agrees with the configuration", () => {
    const declared: Capability[] = ["chat", "vision"];
    const result = reconcileCapabilities(declared, ["vision"]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.capabilities).toEqual(declared);
  });

  it("keeps the declared order so a descriptor is stable across restarts", () => {
    expect(
      reconcileCapabilities(["chat", "vision", "coding"], ["vision"])
        .capabilities,
    ).toEqual(["chat", "vision", "coding"]);
  });
});

describe("asking Ollama what a model can do", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the native route beside the configured OpenAI-compatible one", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ capabilities: ["completion", "vision"] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOllamaCapabilities("http://127.0.0.1:11434/v1", "qwen3.5:9b"),
    ).resolves.toEqual(["vision"]);
    expect(String(fetchMock.mock.calls[0]?.at(0))).toBe(
      "http://127.0.0.1:11434/api/show",
    );
  });

  // Every one of these must be "could not ask", never "asked, and it can do
  // nothing" — the two differ by the routing of every request the model would
  // otherwise serve.
  it.each([
    [
      "an endpoint that refuses",
      async () => new Response("nope", { status: 404 }),
    ],
    [
      "a body that is not the expected shape",
      async () =>
        new Response(JSON.stringify({ capabilities: "vision" }), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "a response with no capabilities at all",
      async () =>
        new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "a transport failure",
      async () => {
        throw new Error("ECONNREFUSED");
      },
    ],
  ])("returns no answer rather than an empty one for %s", async (_label, responder) => {
    vi.stubGlobal("fetch", vi.fn(responder));
    await expect(
      fetchOllamaCapabilities("http://127.0.0.1:11434/v1", "model"),
    ).resolves.toBeUndefined();
  });

  it("discards a non-string entry instead of failing on it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ capabilities: ["vision", 7, null] }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      fetchOllamaCapabilities("http://127.0.0.1:11434/v1", "model"),
    ).resolves.toEqual(["vision"]);
  });
});

describe("who decided each capability", () => {
  const declared: Capability[] = ["chat", "reasoning", "coding", "vision"];

  // The correction. A boolean over the whole list said "the probe replied",
  // which reads as a blessing over capabilities the probe never examines — a
  // model could be marked verified while `reasoning` and `coding` stayed
  // unchecked config.
  it("confirms only the capabilities a probe actually decides", () => {
    expect(splitCapabilityProvenance(declared, true)).toEqual({
      confirmed: ["vision"],
      asserted: ["chat", "reasoning", "coding"],
    });
  });

  it("confirms nothing at all when the runtime could not be asked", () => {
    expect(splitCapabilityProvenance(declared, false)).toEqual({
      confirmed: [],
      asserted: declared,
    });
  });

  // A probed model with no derived capabilities is not the same as one that was
  // never asked — but neither has anything confirmed, and both must say so.
  it("confirms nothing for a probed model that reported no derived capability", () => {
    expect(splitCapabilityProvenance(["chat", "coding"], true).confirmed).toEqual(
      [],
    );
  });

  it("accounts for every capability exactly once", () => {
    for (const probed of [true, false]) {
      const split = splitCapabilityProvenance(declared, probed);
      expect([...split.confirmed, ...split.asserted].sort()).toEqual(
        [...declared].sort(),
      );
    }
  });
});
