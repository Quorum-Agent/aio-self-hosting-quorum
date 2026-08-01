# 003: descriptor-bridge

## Question

**Given** Hermes `ProviderProfile` data plus live model catalogs (Ollama `/api/tags`,
OpenRouter `/api/v1/models`),
**when** Quorum `ModelDescriptor`s are generated for Ollama-loopback and OpenRouter providers,
**then** are `location`, `transport`, `capabilities`, and `contextWindow` populated
correctly with no hand-editing?

## Why this matters

The policy planner's inputs are descriptors. If the bridge can't derive them from what
Hermes already knows (profiles, catalogs, `is_local_endpoint`), every provider becomes
a hand-maintained mapping table — the exact "one fact, two fields" defect class the
Quorum codebase is built to avoid.

## Approach

1. Define the Python mirror of Quorum's `ModelDescriptor` (types only — no planner yet).
2. Write `derive_location(base_url) -> ExecutionLocation` mapping Hermes's
   `is_local_endpoint` semantics onto Quorum's ordered tiers:
   - loopback / container-local DNS / unqualified hostnames → `local`
   - RFC-1918 / Tailscale CGNAT (Hermes treats as "local endpoint" but bytes DO leave
     the device) → `network`
   - everything else → `cloud` unless the operator declares `remote` (rented box)
3. Write `capabilities_for(model, provider)` from catalog metadata:
   - Ollama `/api/show` → `capabilities` field (`thinking`, `vision`, `tools`) where available
   - OpenRouter catalog → `architecture.modality` / `supported_parameters`
   - fallback: chat-only, marked `available` with reduced capability set
4. Write `context_window_for(model, provider)` from catalog context_length; error if unknown
   (never guess — a wrong context window is a routing bug).
5. Run against: (a) a recorded Ollama `/api/tags`+`/api/show` payload, (b) a recorded
   OpenRouter `/models` payload, (c) synthetic provider profiles for a Tailscale peer
   and a rented GPU box.

Hardcoded fixtures, no network — it's a spike.

## Files

- `bridge.py` — descriptor types + derivation functions
- `fixtures.py` — recorded catalog payloads
- `run.py` — CLI: prints derived descriptors for each fixture provider

## Verdict: VALIDATED

### What worked
- Location derivation from `base_url` alone covers loopback, docker DNS, unqualified
  hostnames, RFC-1918 LAN, Tailscale CGNAT, and vendor APIs — 8/8 correct, zero
  hand-editing. The split from Hermes's `is_local_endpoint` (which lumps loopback +
  RFC-1918 + Tailscale for *timeout* purposes) into Quorum's `local` vs `network`
  (which differ by whether bytes leave the *device*) is clean and necessary.
- Ollama `/api/show` capabilities map 1:1 (`thinking`→reasoning, `vision`→vision,
  `tools`→tools); older servers without the field degrade to chat-only safely.
- Context windows are discoverable from both catalogs (arch-scoped
  `<arch>.context_length` for Ollama, `context_length`/`top_provider` for OpenRouter).
  Missing context raises rather than guesses — a wrong context window is a routing bug.
- OpenRouter pricing flows into `cost_per_million_tokens` (prompt+completion), which
  the spend-guardrail design (Quorum architecture.md) can consume directly.

### What didn't (at first)
- `ipaddress.is_private` covers documentation ranges (TEST-NET etc.), not just
  RFC-1918 — caught by the spike's own failing check. Harmless here (documentation
  ranges aren't routable), but the production port should enumerate RFC-1918
  explicitly per the "acceptance predicate enumerates what's allowed" principle from
  Quorum's loopback-url.ts.

### Surprises
- **A rented box's public IP is indistinguishable from a vendor API by URL alone.**
  Location `remote` (you rent the stack) can never be derived — it must be
  operator-declared. This belongs in the production bridge's config surface, not in
  `derive_location`.
- Hermes already has Tailscale CGNAT awareness in `is_local_endpoint` — the mental
  models align better than expected; the bridge is a mapping, not a fight.

### Recommendation for the real build
- Port `derive_location` + the capability/context extractors into `hermes_routing/`
  as the descriptor factory.
- Add an operator-declared `location` override in provider config for the `remote`
  tier (rented GPU); default stays derived.
- Quality rating and specialties stay operator-declared (neutral defaults 50/[]),
  matching Quorum's static model until the eval harness exists.
- The descriptor ID format `{location}:{provider}:{model}` carries the tier so logs
  and ledgers read correctly without joins.
