import type { PolicyDefinition, PolicyMode } from "./types.js";

/**
 * Each policy declares how far it lets work travel, rather than a set of
 * booleans that have to be read together to find out.
 *
 * The previous shape was `allowNetwork` + `allowCloudModels` + `preferLocal`.
 * In all five policies `allowNetwork` and `allowCloudModels` held the same
 * value, so nothing is lost by separating the two questions they were
 * conflated into — but they *are* two questions, so they get two ceilings
 * rather than one.
 *
 * Behaviour is deliberately preserved exactly.
 *
 * An earlier version of this comment recommended loosening `private`'s
 * `toolCeiling` from `"none"` to `"local"`, on the grounds that a SearXNG on
 * loopback "never leaves the device". **That premise was wrong and has been
 * removed elsewhere**: SearXNG is a metasearch proxy that forwards the query
 * to Google and Bing, so it egresses regardless of where the instance
 * listens, and it is now classified `cloud` accordingly.
 *
 * The recommendation is also a no-op in the wrong direction today. No tool can
 * be `location: "local"` — `providerTool` defaults to `"cloud"` and every
 * concrete provider takes the default — so `toolCeiling: "local"` is
 * behaviourally identical to `"none"`, and an operator following the old
 * advice would think they had loosened `private` while changing nothing.
 *
 * A `local` tool ceiling becomes meaningful when a search tool exists that
 * genuinely terminates on the device. None does. Until then the tool axis has
 * two live values and its ordering buys nothing — the ordered comparison is
 * kept because it is what makes such a tool safe to add later, rather than
 * something that needs this rule rediscovered.
 *
 * The tool ceilings say `"web"` rather than `"cloud"`. Both permit today's
 * providers, since `web` sits below `cloud`, but `"web"` is the precise
 * statement: tools may reach the public internet, and that is a different
 * permission from letting a model reach a vendor's API. Writing `"cloud"` here
 * granted more than was meant and read as though a search provider were a
 * model vendor.
 */
export const POLICIES: Record<PolicyMode, PolicyDefinition> = {
  private: {
    id: "private",
    label: "Private",
    // Not "keep tools on this machine" — `toolCeiling: "none"` means no tool
    // runs at all, and no tool can be `location: "local"` today anyway (see the
    // note above). Other shipped copy already said "Private and Offline
    // policies never search", which the old wording contradicted.
    description: "Keep inference on this machine and run no tools.",
    inferenceCeiling: "local",
    toolCeiling: "none",
    preferLocal: true,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description:
      "Prefer local execution; allow automatic web search and cloud only when they add clear value.",
    inferenceCeiling: "cloud",
    toolCeiling: "web",
    preferLocal: true,
  },
  quality: {
    id: "quality",
    label: "Best quality",
    description: "Choose the strongest available route for each request.",
    inferenceCeiling: "cloud",
    toolCeiling: "web",
    preferLocal: false,
  },
  offline: {
    id: "offline",
    // `device` is the whole of it. Invariant I-4 — "offline excludes loopback
    // endpoints as well as remote endpoints" — used to be enforced by the
    // planner testing `request.policy === "offline"` by name and then checking
    // transport. Declaring the ceiling makes the exception a value.
    //
    // What this mode means, because the previous description got it wrong and
    // that wording then misled a reader into treating the mode as a privacy
    // guarantee: **every computation runs on this machine**. It is a statement
    // about where work happens, not a promise that no byte ever leaves.
    //
    // The ceilings scope *request execution* — which model answers, which tools
    // a request may reach. They say nothing about application maintenance such
    // as fetching a model catalogue, because that is not computation the user
    // asked for and is not performed by a model. Read this before concluding
    // that some background fetch "violates offline"; it does not, and the
    // question to ask instead is whether the app still starts with no network
    // at all, which it must.
    label: "Offline",
    // Third wording of this one sentence, and the second time it has been
    // wrong. It said "Disable every network operation, including local network
    // endpoints" — a privacy claim about a compute-locality mode. Rewriting it
    // to positive framing produced "Run every computation on this machine,
    // including the local network", where "including" silently changed what it
    // attached to: from what is DISABLED to what is PERMITTED. That states the
    // opposite of the ceiling. `device` is the lowest tier, so offline excludes
    // loopback and the LAN as well as everything further out — see the
    // invariant "Offline mode excludes loopback endpoints as well as remote
    // endpoints". Name what runs, and name what is excluded, separately.
    description:
      "Run every computation inside Quorum itself. No loopback server, no local network, nothing beyond.",
    inferenceCeiling: "device",
    toolCeiling: "none",
    preferLocal: true,
  },
  cost_controlled: {
    id: "cost_controlled",
    label: "Cost controlled",
    description: "Prefer free local routes and cap exceptional cloud use.",
    inferenceCeiling: "cloud",
    toolCeiling: "web",
    preferLocal: true,
    cloudBudgetUsd: 1,
  },
};

export function getPolicy(mode: PolicyMode): PolicyDefinition {
  return POLICIES[mode];
}
