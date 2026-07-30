# Red-team remediation audit — 2026-07-30

This document records the disposition of `REDTEAM-FINDINGS.md` against the
hardening branch. “Repaired” means the reported failure path is removed and covered
by code or regression tests. “Hardened” means the concrete exploit was removed, but
the broader problem cannot honestly be treated as solved by a finite heuristic.

## Critical and high findings

| Finding | Disposition | Repair |
| --- | --- | --- |
| Q-01 | Repaired | Assistant messages derived from web retrieval carry durable provenance. Any later request containing that history is local-only, including history loaded from older execution records. |
| Q-02 | Hardened | Sensitive detection now normalizes NFKC/confusables/format characters; recognizes structured credentials, high-entropy tokens, key material, financial and government identifiers, contact bundles, and first-person health context; and reports matched categories. Detection is deliberately documented as bounded rather than comprehensive multilingual PII recognition. |
| Q-03 | Repaired | Source titles are normalized and stripped of format/bidirectional controls. Sources remain structured execution data and are no longer concatenated into model-authored answer text. Rendered source links use bidirectional isolation. |
| Q-04 | Repaired | Network denials match ordinary whitespace and veto web authorization. Regression cases cover “do not,” “don’t,” and “never.” |
| Q-05 | Repaired | Coding signals take precedence over abstract visual nouns; vision requires a referential/attachment-like visual request. |
| Q-06 | Repaired | Caller queue budgets are honored, actual wait durations are reported, and request-level scheduler failures surface as failures instead of falling through to the scaffold responder. |
| Q-07 | Hardened | Search receives only the current user prompt. Raw prior turns and model-authored task summaries are never used as outbound queries. Per-search confirmation is not yet part of the automatic-search product flow. |
| Q-08 | Repaired, UX follow-up | Providers fit a recent context window while preserving the current request and tool evidence, with an actionable error only when the current turn itself cannot fit. Conversation deletion/export now provides recovery. “Branch from here” remains a separate conversation UX feature. |
| Q-09 | Repaired | Startup discovery retries with backoff, untagged names match `:latest`, and missing configured roles/classifier are rediscovered on runtime reads and forcibly before chat planning. |
| Q-10 | Repaired | Cloud disclosure is durable and visible at Standard verbosity, not only in the live inspector. |
| Q-11 | Mitigated | Untrusted search framing remains intact; source spoofing is removed; and web-grounded output can no longer silently become cloud-trusted context. Prompt-layer instructions are not treated as a complete injection defense. |

## Medium findings

| Finding | Disposition | Repair |
| --- | --- | --- |
| Q-12 | Repaired | Cloud context and quality are configurable. The specialty bonus lets a matching local specialist beat the default cloud rating while preserving meaningful larger quality gaps. |
| Q-13 | Repaired | Chat is rejected with a recoverable preparing response while startup warmup owns local inference; no user turn is saved or fabricated during that interval. |
| Q-14 | Repaired | The most recent standing network authorization or denial controls referential follow-ups, so a later denial cannot be overridden by an older authorization. |
| Q-15 | Repaired | First-person schedules, prices, health, contact, and financial scope suppress web routing and activate the privacy guard. |
| Q-16 | Repaired | `QUORUM_WEB_SEARCH_ENABLED=false` is authoritative over saved settings. |
| Q-17 | Repaired | Rename, export, and delete are implemented in persistence, HTTP routes, client calls, and sidebar controls. |
| Q-18 | Repaired with fail-closed policy | Only user-authored content contributes to the detector; cited false positives were removed; matched categories are disclosed. A sensitive-egress override is intentionally not enabled without an explicit product/security decision. |
| Q-19 | Repaired | The global limiter charges one slot per logical search signal, not per provider attempted by Auto. |
| Q-20 | Repaired | Provider construction is inside the candidate try/catch, so bad configuration is recorded and Auto continues safely. |
| Q-21 | Repaired | Analyzer free text is never an outbound query. |
| Q-22 | Repaired | Explicit running/completed/failed/cancelled status drives live and historical elapsed labels. |
| Q-23 | Repaired | Both URL boundaries use one loopback-host implementation; short-form `127.1` is also treated as private. |
| Q-24 | Repaired | Enter does not submit during IME composition. |

## UX, accessibility, and operations findings

| Finding | Disposition | Repair |
| --- | --- | --- |
| Q-25 | Repaired | Effective text floors are 12px for compact controls/metadata and 14px for body/composer content, including strong text and list/link content. |
| Q-26 | Repaired | Reported low-contrast colors were replaced and disclosure/source surfaces use darker text. |
| Q-27 | Repaired | Messages render safe headings, paragraphs, emphasis, links, lists, blockquotes, tables, and fenced code with a copy action; raw HTML and unsafe links remain inert. |
| Q-28 | Repaired | Composer height follows content up to a bounded maximum. |
| Q-29 | Repaired | Sending no longer changes the user’s inspector-open preference. |
| Q-30 | Repaired | Stop performs a short foreground reconciliation, then continues reconciling the authoritative execution record in the background for up to one minute without overwriting another conversation or newer request. |
| Q-31 | Repaired | In-progress audit rows use empty content plus explicit running status and are excluded from transcript/model context. |
| Q-32 | Repaired | Analyzer queue time is subtracted from its single end-to-end budget. |
| Q-33 | Repaired | Queue failures report the duration actually enforced. |
| Q-34 | Repaired | An empty pending key edit no longer makes an environment-configured provider appear unconfigured. |
| Q-35 | Repaired | Every accepted result limit from 3 through 10 is representable. |
| Q-36 | Repaired | Conversation selection loads before swapping state and handles/reports a failed fetch. |
| Q-37 | Repaired | Provider prose no longer decides cancellation; explicit execution status does. |
| Q-38 | Repaired | Normal runtime polling is reduced and pauses while the document is hidden. |
| Q-39 | Repaired | Attempt callbacks are forwarded through the configurable search provider. |
| Q-40 | Documented; desktop boundary pending | The README and architecture now state that loopback is not authentication against local non-browser processes. Per-launch sidecar authentication remains part of the Tauri desktop-shell boundary in ADR-0001. |

## Security decisions requiring explicit approval

The privacy guard remains fail-closed. A per-message control that allows detected
credentials, PII, or health data to leave the device would be an intentional weakening
of a current security invariant. If added, it should be an explicit one-turn consent,
default off, name the detected categories and destination, reset after send, and be
recorded in durable execution evidence.

