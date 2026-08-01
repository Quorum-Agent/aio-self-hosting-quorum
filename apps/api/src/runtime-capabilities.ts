import type { Capability } from "@quorum/core";

/**
 * Ask the runtime what a model can do, instead of declaring it in config.
 *
 * `apps/api/src/config.ts` stamps the same four capabilities —
 * `["chat", "reasoning", "coding", "documents"]` — onto every local model,
 * regardless of what the model is. Measured against the twenty models installed
 * on the development machine, that declaration is wrong in both directions:
 *
 * - `qwen3.5:9b`, `ministral-3:8b`, `gemma4:12b` and `gemma4:e4b` all report
 *   `vision`, and Quorum could not route an image to any of them. ADR 0002
 *   opens by naming this exact symptom — "`vision` is declared and served by
 *   nothing" — and the cause was never a missing model.
 * - `phi4:14b-q4_K_M` reports `completion` alone: no tools, no thinking. It was
 *   being advertised as a reasoning and coding route.
 *
 * Ollama answers this on `/api/show`, which is the same endpoint discovery
 * already talks to. No registry, no join, no cache, no network beyond the one
 * already in use — the artifact is asked directly, which is the rule this
 * repository applies to context windows and load compatibility already.
 */

/** Ollama's `/api/show` response, narrowed to the field this reads. */
interface ShowResponse {
  capabilities?: unknown;
}

/**
 * Which runtime capabilities map onto Quorum's vocabulary — and, more
 * importantly, which deliberately do not.
 *
 * Only two entries, and the omissions are the argument:
 *
 * - **`thinking` is not `reasoning`.** It reports a suppressible thinking mode,
 *   not an aptitude. A model without one still reasons in its answer, so
 *   treating this as authoritative would strip `reasoning` from `llama3.1:8b`
 *   and `mistral-nemo` and make them ineligible for work they do perfectly
 *   well. Capabilities are hard eligibility filters — a wrong removal does not
 *   degrade an answer, it dead-ends the request in the scaffold responder.
 * - **`insert` is not `coding`.** It reports fill-in-the-middle support, which
 *   correlates with code models and does not define them.
 * - **`completion` is not `chat`.** Every model reports it; it discriminates
 *   nothing.
 * - **`audio` has no Quorum capability yet.** Adding one here would declare a
 *   route the product cannot serve, which is the defect this module fixes.
 *
 * What is left is the pair a runtime can answer definitively and a user can
 * observe being wrong: a model either accepts image input or it does not, and
 * either implements tool calls or it does not.
 */
export const RUNTIME_CAPABILITY_MAP: Readonly<Record<string, Capability>> =
  Object.freeze({
    vision: "vision",
    tools: "tools",
  });

/** The Quorum capabilities this module is willing to decide. */
export const DERIVED_CAPABILITIES: readonly Capability[] = Object.freeze(
  Object.values(RUNTIME_CAPABILITY_MAP),
);

export interface CapabilityReconciliation {
  capabilities: Capability[];
  added: Capability[];
  removed: Capability[];
}

/**
 * Combine what config declared with what the runtime reports.
 *
 * The runtime decides membership for `DERIVED_CAPABILITIES` and only those.
 * Everything else config declared is carried through untouched, because no
 * runtime reports on it and a silent drop would be a routing change nobody
 * asked for.
 *
 * Order is preserved from the declaration so that a descriptor's capability
 * list stays stable across restarts; additions append.
 */
export function reconcileCapabilities(
  declared: readonly Capability[],
  runtimeReported: readonly Capability[] | undefined,
): CapabilityReconciliation {
  // No answer is not the same as an empty answer. A runtime that cannot be
  // asked — llama.cpp, an OpenAI-compatible endpoint, a failed probe — leaves
  // the declaration alone rather than stripping every derived capability from
  // every model.
  if (!runtimeReported) {
    return { capabilities: [...declared], added: [], removed: [] };
  }

  const reported = new Set(runtimeReported);
  const kept = declared.filter(
    (capability) =>
      !DERIVED_CAPABILITIES.includes(capability) || reported.has(capability),
  );
  const added = DERIVED_CAPABILITIES.filter(
    (capability) => reported.has(capability) && !declared.includes(capability),
  );
  const removed = declared.filter(
    (capability) =>
      DERIVED_CAPABILITIES.includes(capability) && !reported.has(capability),
  );

  return { capabilities: [...kept, ...added], added: [...added], removed: [...removed] };
}

/**
 * Split a model's capabilities by who decided them.
 *
 * `confirmed` is narrower than "the probe succeeded", which is the distinction
 * that made the first version of this dishonest: a probe decides `vision` and
 * `tools` and says nothing about the rest, so a model with a successful probe
 * still carries `chat`, `reasoning`, `coding` and `documents` on nobody's
 * authority but the configuration file's.
 *
 * A model that could not be probed has nothing confirmed — including the
 * derived pair, whose presence or absence in that case is also just config.
 */
export function splitCapabilityProvenance(
  capabilities: readonly Capability[],
  probed: boolean,
): { confirmed: Capability[]; asserted: Capability[] } {
  if (!probed) {
    return { confirmed: [], asserted: [...capabilities] };
  }
  return {
    confirmed: capabilities.filter((capability) =>
      DERIVED_CAPABILITIES.includes(capability),
    ),
    asserted: capabilities.filter(
      (capability) => !DERIVED_CAPABILITIES.includes(capability),
    ),
  };
}

/** Translate the runtime's vocabulary, discarding what does not map. */
export function mapRuntimeCapabilities(reported: readonly string[]): Capability[] {
  const mapped = reported.flatMap((name) => {
    const capability = RUNTIME_CAPABILITY_MAP[name];
    return capability ? [capability] : [];
  });
  return [...new Set(mapped)];
}

/**
 * Ask Ollama what one model can do.
 *
 * Returns `undefined` for every failure — unreachable, wrong shape, timed out,
 * not an Ollama endpoint — because "could not ask" and "asked, and it can do
 * nothing" must not collapse into the same value. They differ by exactly the
 * routing of every request the model would otherwise serve.
 *
 * The base URL is the OpenAI-compatible one already configured, with the `/v1`
 * suffix removed: `/api/show` is Ollama's native route and sits beside it. The
 * same derivation is used by the native generation path.
 */
export async function fetchOllamaCapabilities(
  baseUrl: string,
  model: string,
  timeoutMs = 1_500,
): Promise<Capability[] | undefined> {
  const nativeRoot = baseUrl.replace(/\/v1\/?$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${nativeRoot}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return undefined;
    const payload = (await response.json()) as ShowResponse;
    if (!Array.isArray(payload.capabilities)) return undefined;
    const reported = payload.capabilities.filter(
      (entry): entry is string => typeof entry === "string",
    );
    return mapRuntimeCapabilities(reported);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
