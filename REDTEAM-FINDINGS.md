# Quorum — red team findings

**Reviewed:** 2026-07-30 · **Commit:** `a2439e6` · **Baseline:** 664 tests passing, typecheck clean

Adversarial review of the routing/orchestration layer, covering security, privacy-claim
integrity, correctness, and UX/accessibility. Method: manual source review plus executed
probes against the built `dist/`, followed by a multi-agent sweep of the remaining files and
an adversarial refutation pass over every inspection-only claim.

## How to read this

| Tag | Meaning |
| --- | --- |
| **[CONFIRMED]** | Reproduced by executing the shipped code. A probe exists. |
| **[VERIFIED×2]** | Reproduced independently by two reviewers. |
| **[PLAUSIBLE]** | Traced in code and survived a skeptic pass, but not reproduced end to end. |
| **[INSPECTION]** | Read from source only. Lowest confidence — challenge these first. |

IDs are stable; reference them in commits and issues. Findings that were investigated and
**dismissed** are listed in §7 so nobody re-litigates them. Please read §6 before changing
anything in `route-planner.ts`, `orchestrator.ts`, or the provider adapters — several
non-obvious protections are load-bearing and currently correct.

---

## 1. Critical

### Q-01 · Web-retrieved content reaches the cloud on the next turn [CONFIRMED]

README: *"Retrieved web data is never forwarded to a cloud model."* This holds **within a
request** — `orchestrator.ts:281-287` forces every cloud model `available:false` before planning
the post-search route, and the fallback planner (`:704-712`) keeps cloud disabled while the
failing provider is local. That code is correct.

But the answer *synthesized from* the web evidence, with the source appendix attached, is
persisted as an ordinary assistant message. Next turn `buildAuthoritativeContext` replays it, and
under `quality` policy the planner picks the cloud model and ships it. Reproduced:

```
TURN 1 (quality): websearch fired, route=local
TURN 2 (quality): route=cloud
  >>> context the CLOUD model actually received:
   "user: What is the latest news on the OpenSSL CVE? search the web"
   "assistant: answer from local:general:qwen\n\nSources\n...[1] CVE-2026-1234 advisory"
   "user: Write that up as a short paragraph."
```

The tool message is correctly not persisted — but the derived answer is, which is the part that
matters. There is no taint tracking, so the guarantee cannot survive a second turn.

**Fix:** add `ChatMessage.provenance: "web_grounded"`; either exclude tainted messages from cloud
dispatch or require explicit consent. Until then, scope the README claim to "within the
retrieving request."

### Q-02 · The sensitive-data gate misses most real secrets and PII [CONFIRMED]

`containsSensitiveContent` (`request-compiler.ts:326`) is the **sole** control behind three
advertised guarantees: no cloud routing, no web search, and search-result filtering. Measured:

| Input | Detected? |
| --- | --- |
| `aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` | **no** |
| `AIzaSyD-1234567890abcdefghijklmnopqrstu` (Google API key) | **no** |
| `My social is 123456789` (SSN without dashes) | **no** |
| `my passwd is hunter2` / `passphrase` | **no** |
| `DB_PASS=s3cr3t` | **no** |
| `Jane Q. Doe, born 1984-03-11, 12 Elm St, 555-867-5309` | **no** |
| `I was just diagnosed with stage 2 lymphoma` | **no** |
| `GB33BUKB20201555555555` (IBAN) | **no** |
| PEM body without the `-----BEGIN` header | **no** |
| `my pаssword is hunter2` (Cyrillic а) | **no** |
| `my pass​word is hunter2` (zero-width space) | **no** |

Only `AKIA…`, `sk-…`, `ghp_…`, `xox…`, JWTs, DB URIs, dashed SSNs, Luhn-valid cards, and ~20
English keywords are caught. English-only — no other language has any coverage.

**Fix:** entropy/structural detection (high-entropy token scan, `KEY=VALUE` heuristics, PII NER),
plus NFKC normalization + confusable folding + zero-width stripping **before** matching. And stop
implying in-product that detection is comprehensive.

### Q-03 · Attacker-controlled text is appended *after* output validation [CONFIRMED]

The envelope validator itself is sound — nested tags, repeated tags, preamble/suffix,
post-terminal records, and visually-blank content are all correctly rejected, and no bypass was
found. Then `orchestrator.ts:629-641` runs downstream of it:

```ts
const sources = webSearchResponse.results
  .map((source, index) => `[${index + 1}] ${source.title} — ${source.url}`).join("\n");
content += "\n\nSources\n...\n" + sources;
```

`source.title` is arbitrary text from an attacker-controlled page. `compactText` strips only C0
controls and collapses whitespace. Confirmed to survive: **U+202E** (RTL override), **U+2066/2069**
(bidi isolates), **U+200B** (zero-width space). Rendered output (`.message p` is `white-space:
pre-wrap`):

```
Sources
External destinations are not network-verified; inspect links before opening.
[1] PayPal Account Verification ‮gro.lapyap-eruces//:sptth — https://attacker.example/paypal
```

The RLO renders that title as a plausible `https://secure-paypal.org` immediately before the real
destination. The same string is the anchor **text** in `ExecutionPanel.tsx:187-189`. The product
tells users to "inspect links before opening" — bidi override is exactly the attack that defeats
visual inspection.

**Fix:** strip `\p{Cf}` and bidi controls in `compactText`; apply `unicode-bidi: isolate` to source
titles; and build the appendix structurally in React from `plan.webSearch.sources` rather than
string-concatenating into the model's answer.

---

## 2. High

### Q-04 · Refusing the internet *causes* internet access [VERIFIED×2]

`request-compiler.ts:58`. `NETWORK_DENIAL_PATTERN`'s verb branch is
`(?:do not|don'?t|never)\s+(?:use|search|access|contact)(?:the\s+)?(?:internet|web|…)` — there is
**no `\s+` between the verb group and the subject group**, so it only matches text with no space
there (`"do not usethe internet"`). No real prose matches. Worse, the same words match
`EXPLICIT_WEB_REQUEST_PATTERN`'s `use (?:the )?internet`, so the refusal becomes the *sole* signal
promoting the turn to research-with-web:

```
web=true  intent=research      "Do not use the internet. Summarize the Acme merger for me."
web=true  intent=research      "Don't search the web. What are the latest news on the merger?"
web=true  intent=research      "Never access the internet. Explain the current prices."
web=false intent=conversation  "Answer offline only. Summarize the Acme merger."   ← only working branch
```

Per Q-07 the prompt text then goes to the search provider. Only the `offline` / `local-only`
branches function.

**Fix:** add the missing `\s+`, and make any denial match veto the `web` capability
unconditionally instead of competing with the authorization patterns.

### Q-05 · Ordinary coding questions dead-end in the scaffold responder [VERIFIED×2]

`request-compiler.ts:129`. `VISION_PATTERN` (`\b(image|photo|picture|diagram|screenshot|visual|
pcb)\b`) is evaluated **before** the coding branch, returns `intent=vision` at 0.94, and requires
the `vision` capability. **No provider declares it** — general `[chat,reasoning,coding,documents]`,
coding `[chat,coding]`, reasoning `[chat,reasoning]`, cloud `[chat,reasoning,coding,documents]`,
scaffold `[chat]`. The eligible set is empty, so every one of these hits the scaffold:

```
intent=vision  "How do I build a Docker image?"
intent=vision  "Write a function to resize an image in Python."
intent=vision  "Explain the architecture diagram pattern for microservices."
intent=vision  "Take a screenshot programmatically in Node."
```

"How do I build a Docker image?" is about as ordinary as a developer question gets, and Quorum
answers with a canned "no eligible configured model" message. This will read to users as a broken
product.

**Fix:** order the vision branch after coding, gate it on an actual attachment signal, and never
emit a capability no registered model can satisfy.

### Q-06 · Concurrent requests get a fabricated answer, persisted as history [CONFIRMED]

`inference-scheduler.ts:101`. `acquire()` arms its timer at
`Math.min(this.#queueWaitMs = 30_000, maximumWaitMs)`, so a caller's budget can only be *reduced*.
Every construction site is `new InferenceScheduler()` (`runtime.ts:44,135`), so the cap is always
30s — while a legitimate in-budget answer may hold the slot for `DEFAULT_TIMEOUTS.totalMs = 90_000`.

Reproduced: user A's model streams a legitimate 55s answer; a second tab sends a request 1s later
and is evicted at t+30s with `ModelExecutionError` kind `"request"`. Because the kind isn't
`"provider"` no provider health is recorded; `attemptContent` is empty, so the orchestrator
excludes the local provider, marks cloud unavailable, and re-plans onto `DemoProvider`:

```
t+30.0s [B] trace failed: Local inference queue wait exceeded 90000ms.
t+30.0s [B] content: "Quorum received this as a coding request and kept the scaffolded
                      execution local. No eligible configured model completed a safe public answer…"
```

**No `error` event is emitted at any point.** `server.ts:333-340` persists it as a normal assistant
message, so a fabricated non-answer becomes durable history *and* model context next turn.
`inference-scheduler.test.ts` never passes `maximumWaitMs`, so the cap is untested.

**Fix:** don't clamp the caller's budget below what it requested — or bound the hold, not the wait.

### Q-07 · A referential follow-up ships the previous message verbatim to a third party [CONFIRMED]

`orchestrator.ts:239-262`. When `intentSource === "conversation"`, the query becomes
`${priorContext} Follow-up: ${prompt}`, where `priorContext` is the previous user message's **full
content** (truncated at 500 chars). The user types five words; this leaves the machine:

```
user typed:  "what's the latest on that?"
sent to DuckDuckGo:
  "Search the web for precedents. Background: my employer Northwind Health is under federal
   investigation for billing at the Tulsa clinic, and I am the whistleblower who filed it.
   Follow-up: what's the latest on that?"
```

Guarded only by Q-02's regex, which catches none of this. The disclosure (`plan.webSearch.query`)
is post-hoc and only visible with the inspector open. Everything in Q-02's miss table is
exfiltratable this way.

**Fix:** never send raw prior turns. Use the bounded `taskSummary` only, cap at ~200 chars, and
confirm the exact outbound query before the first search of a conversation.

### Q-08 · Conversations become permanently unusable at ~45 KB [CONFIRMED]

No context truncation, eviction, or summarization exists anywhere.
`buildAuthoritativeContext` returns every stored message; `stream()` then hard-fails:

```
input budget: 15616 tokens (16384 ctx − 768 reserved at standard verbosity)
conversation dies after ~38 messages of 1200 chars (~45 KB of chat)
```

Past that, every turn throws `ModelExecutionError(..., "request")`, falls through each model, and
lands on the scaffold — which blames a missing endpoint, a missing model, or failed validation.
All three are wrong. There's no in-UI fix and no delete control (Q-17), so the conversation is
dead weight in the sidebar forever. This will hit every serious user.

**Fix:** sliding-window context plus summarization; a specific error ("this conversation exceeds
the model's context"); and a "branch from here" action.

### Q-09 · A boot-order race converts a local-first install into a cloud-only one [CONFIRMED]

`runtime.ts:136` is the only call to `discoverModels`, made once at startup. No refresh route
exists, and `currentLocalRuntime` only re-reads `available` on providers **created at startup**, so
nothing can resurrect a provider that was never constructed.

Cloud registration (`runtime.ts:166-181`) does **not** depend on local discovery. With a cloud key
set and Ollama not yet listening at startup — both auto-starting at login, or the Tauri sidecar in
ADR-0001 — the registered set is exactly `[cloud:gpt-4.1-mini (quality 90), local:scaffold
(quality 1)]`. **Every request for the life of the process routes to the cloud.** Recoverable only
by restarting the API. Verified end to end: bringing Ollama up afterwards changes nothing.

Secondary: name matching is exact string equality, so `QUORUM_LOCAL_MODEL=llama3.2` (which Ollama
accepts for inference, resolving `:latest`) is compared against `llama3.2:latest` and dropped.
*Note: quantized tags are fine — Ollama returns them verbatim in `/v1/models`.*

**Fix:** retry discovery with backoff; re-probe lazily on `/api/runtime` and before planning;
normalize an untagged configured name against `<name>:latest`.

### Q-10 · A successful cloud turn leaves no durable disclosure [CONFIRMED]

`MessageExecutionActivity.tsx:25`. Driving the real orchestrator, a successful cloud turn persists
`{route:"cloud", attempts:[{route:"cloud", status:"completed", contextMayHaveBeenTransmitted:true}],
cloudDisclosure:"The conversation context required by the selected model will leave this device."}`.
Rendering that record produces **a zero-length string**, because the guard requires
`verbosity === "detailed"`.

`cloudDisclosure` is dead data — **no renderer consumes it anywhere in the app.** At the default
Standard verbosity, scrolling back through a transcript shows no evidence a turn left the device.
Only *failed* cloud attempts are durable. (At Detailed verbosity the rail does survive, so the
architecture doc's "survives reloads" sentence is technically scoped correctly.)

### Q-11 · Indirect prompt injection via search snippets [INSPECTION]

Snippets (up to 2400 chars × 10) reach the local model inside a per-request UUID frame with a
strong untrusted-data preamble (`toProviderMessage`) — a good design, better than most. But it's
still mitigation-by-instruction against a 9B model. Frame escape is unlikely; the realistic
outcome is content manipulation, which compounds with Q-03's spoofed sources and Q-01's cloud
forwarding.

**Fix:** unfixable at the prompt layer. Invest in the output side (Q-03) and in never letting
web-grounded output silently gain trust.

---

## 3. Medium

- **Q-12 · Cloud always wins Best quality; specialists structurally cannot compete** [CONFIRMED]
  Local specialist `qualityRating: 65` (`config.ts:196,209`) + `SPECIALTY_BONUS: 12` = **77**.
  Cloud is hardcoded to **90** (`runtime.ts:176-178`) regardless of which model is configured, with
  `contextWindow: 128_000`. In `quality` mode `preferLocal:false`, so the specialist can never win
  — contradicting the README's *"an opt-in matching specialist can overcome a small static quality
  gap."* Point `QUORUM_CLOUD_MODEL` at a cheap small model and Quorum still rates it above every
  local option and will overflow its real context window.
- **Q-13 · Warmup holds the only inference slot from before the port opens** [CONFIRMED]
  `model-warmup.ts:39` calls `scheduler.acquire()` as its first statement and takes the slot
  synchronously; the warmup IIFE (`runtime.ts:225`) is never awaited, and `index.ts:12` returns
  past it and then listens. The **first message after a restart** loses classification at t+20s,
  loses its answer route at t+50s, and is answered by the scaffold — and persisted (see Q-06). No
  back-pressure, no retry. `WARMUP_TIMEOUT_MS = 180_000` shows multi-minute loads are anticipated.
- **Q-14 · A standing "answer offline only" is forgotten one turn later** [CONFIRMED]
  `request-compiler.ts:297`. `currentPromptBlocksWeb` inspects only the latest prompt, while
  `priorPromptAuthorizesWeb` `.some()`s over *all* prior user messages. Turn 1 authorizes web,
  turn 2 denies it, turn 3 ("Also tell me more.") inherits research intent and **re-grants web** —
  the chronologically later denial is filtered out of the scan and can never veto it.
- **Q-15 · Personal phrasings acquire `web` and leave the device** [CONFIRMED]
  `request-compiler.ts:24`. `CONTEXTUAL_CURRENT_PATTERN` includes the generic nouns
  `schedules?`/`prices?`; `EVIDENCE_REQUEST_PATTERN` fires on `sources? (for|on|about)` anywhere.
  Neither requires an external public subject and a first-person possessive doesn't suppress
  either: **"What is my current medication schedule?"** → `caps=[chat,reasoning,web]` → the literal
  sentence goes to DuckDuckGo on the default policy. Same for *"Give me the sources for my HIV
  medication."* Q-02 + Q-07 compounding into a health-data egress path.
- **Q-16 · Stored settings override the environment kill switch** [CONFIRMED]
  `web-search-provider.ts:1159`. `#effective()` resolves `stored.X ?? bootstrap.X`, so once any
  save has written a row, `QUORUM_WEB_SEARCH_ENABLED=false` in `.env` is dead — no comparison, no
  log line. The operator's kill switch silently does nothing.
- **Q-17 · No way to delete, rename, or export a conversation** [CONFIRMED]
  No `DELETE` route exists and the sidebar has no affordance. For a product pitched on "Your
  models. Your data.", the only removal path is stopping the process and hand-deleting
  `var/quorum.db`. Compounds with Q-08 (dead conversations accumulate) and Q-18.
- **Q-18 · The sensitive detector poisons conversations irreversibly** [CONFIRMED]
  `deriveRequirements` computes `containsSensitiveData` across **every** message including
  assistant output. All of these return `true`:
  ```
  "How do I hash a password with bcrypt in Node?"
  "Explain what an API key is."
  "What does 'confidential' mean in a legal contract?"
  "Order number 4532015112830366 shipped today"     (valid Luhn, not a card)
  ```
  That conversation permanently loses cloud routing *and* web search, and the user is told the
  request "appears to contain sensitive data" on turns that contain none. No override, no
  indication of what matched, and per Q-17 no way to delete and restart.
- **Q-19 · Global rate limiter charges one slot per provider *attempt*** [CONFIRMED]
  `web-search-provider.ts:355`, against module-level globals. Healthy path costs 1 slot (the loop
  returns on first success). But when providers earlier in `AUTO_PROVIDER_ORDER` fail **fast**
  (expired key → 401/429, stopped local SearXNG → ECONNREFUSED), each search charges one slot per
  failed attempt. Ceiling is `floor(30/C)` searches/min. Measured at C=7 with only DuckDuckGo
  healthy: searches 1–4 fine, #5 dies partway, #6–8 make **zero** upstream requests for 60s.
  Consequence is worse than the lockout: `orchestrator.ts:466-476` returns with no fallback, so the
  turn yields **no assistant output**, and the message reads *"Web search failed across Exa,
  Perplexity, …"* — the rate-limit string exists only in per-attempt details, so the user is told
  their providers are broken rather than to wait a minute. *(Unreachable on a stock install: C=1.)*
- **Q-20 · `#createProvider` sits outside the candidate loop's try/catch** [CONFIRMED]
  `web-search-provider.ts:1096`. A `SearxngWebSearchProvider` constructor throw ("must use an
  explicit loopback hostname") escapes the whole loop as a raw Error — DuckDuckGo, later in the
  order, is never attempted and the attempts array is lost.
- **Q-21 · Analyzer `task_summary` becomes the outbound query verbatim** [PLAUSIBLE]
  `orchestrator.ts:253`. When the classifier is accepted, the search query is the 2B model's free
  text, validated only for length. The analyzer reads up to 8 prior messages × 2000 chars, which
  per Q-01/Q-03 can carry attacker-influenced text. Contingent on Q-11 plus model drift — no
  deterministic input produces it.
- **Q-22 · Execution rail reads "Worked for Ns" on a request that failed before any model ran**
  [CONFIRMED] `ExecutionActivity.tsx:88`. Failure paths yield a plan with `attempts` undefined, so
  every completed/failed/cancelled derivation is false and the label falls through to the
  in-progress string — sitting above content reading *"Request failed: Exa search failed: HTTP 503."*
- **Q-23 · Two divergent `isLoopbackHostname` implementations** [INSPECTION]
  `outbound-url.ts:3` accepts `*.localhost` and `::ffff:127.*`; `loopback-url.ts:1` accepts
  neither. The first guards the API's Host/Origin check (`server.ts:117-131`), the second guards
  model base URLs. Same name, different semantics, security-relevant in both. Related latent bug:
  `isPrivateHostname` returns **false** for short-form IPv4 like `127.1`. Harmless today because
  `safeResult` URLs are only displayed — it becomes SSRF the moment link-following is added, which
  is on the roadmap.
- **Q-24 · Enter sends mid-IME-composition** [INSPECTION]
  `Composer.tsx:27-32` checks only `event.key === "Enter" && !event.shiftKey`. No `isComposing`
  guard, so confirming a Japanese/Chinese/Korean candidate sends the message. Unusable in CJK
  locales. Fix: `if (event.nativeEvent.isComposing) return;`

---

## 4. Low / UX / accessibility

- **Q-25 · Text is far too small.** 51 of 71 `font-size` declarations are ≤ 10px; **14 are 8px**.
  Body copy is 13px. Browser default is 16px.
- **Q-26 · Contrast failures** (measured; WCAG AA needs 4.5:1): `#92978f` on `#fbfbf9` = **2.88:1**
  at 8px; `#8e938a` = **3.03:1** at 8px; sidebar `#6d746c` on `#171a17` = **3.65:1**; `#6f766f` =
  **3.76:1**. The execution inspector — the product's core differentiator — is its least legible
  surface.
- **Q-27 · No markdown rendering.** `<p>{message.content}</p>`. A product that routes a dedicated
  *coding* intent to a *coding specialist* returns code as an undifferentiated paragraph: no code
  blocks, no highlighting, no copy button, no lists or tables. Biggest gap versus any competitor.
- **Q-28 · Composer never grows.** `<textarea rows={1}>`; the `textarea` ref is declared and never
  used. Multi-line prompts scroll inside one visible line.
- **Q-29 · Inspector force-reopens on every send** (`App.tsx:309`). Close it, send, it reappears.
- **Q-30 · Stop leaves the UI stale.** `App.tsx:356` polls 10 × 100 ms; on timeout the user gets
  "could not yet confirm the saved execution record" and the transcript never reconciles until they
  switch conversations.
- **Q-31 · Audit placeholder text leaks into the transcript.** The web-search audit row is saved as
  an assistant message reading *"Web search started. No terminal execution record was received."*
  (`server.ts:320`). Reload mid-search or crash, and that string is permanently in the user's
  history as if the assistant said it.
- **Q-32 · Analyzer double-spends its 20s budget** (`prompt-analyzer.ts:191`) — once queueing, once
  inferring, because it starts a fresh timer after `acquire()` without subtracting elapsed queue
  time. Measured **25.0s** wall time while reporting *"exceeded its 20000ms limit."* At the queue
  cap, 40s. `openai-compatible-provider.ts:649,682-688` gets this right, so it's an inconsistency.
  Nothing imposes an end-to-end deadline on `/api/chat`.
- **Q-33 · Queue-wait rejection reports the wrong number** (`inference-scheduler.ts:97`) — the
  caller's *requested* budget, not the 30s enforced. Surfaces a 6× wrong value in `/api/health`,
  `/api/runtime`, and the inspector.
- **Q-34 · Backspacing in an env-configured key field blocks Save** (`SettingsDialog.tsx:224`).
  `apiKeyChanges.exa === ""` takes the string branch and never falls back to
  `selectedProvider.configured`, so *"Configure Exa before selecting it."* renders directly under a
  row reading **"Ready"**, blocking unrelated pending edits. The "Remove session key" escape hatch
  isn't rendered for env-sourced keys.
- **Q-35 · Result-limit dropdown can't represent 4, 6, 7, 9** (`SettingsDialog.tsx:370`). The server
  accepts 3–10 but only `[3,5,8,10]` render. With `QUORUM_WEB_SEARCH_RESULT_LIMIT=7`,
  `<select value={7}>` has no match → `selectedIndex = -1` → blank control, and any visible
  selection destroys the value irrecoverably from the UI.
- **Q-36 · `selectConversation` swallows its rejection** (`App.tsx:256`). Sets `conversationId`
  synchronously, then awaits `getMessages(id)` with no try/catch, called as `void …` with no
  ErrorBoundary or `unhandledrejection` handler anywhere. Restart the API against a fresh
  `quorum.db` with the tab open, click a stale entry → 404 → the UI shows the *new* id with the
  *old* transcript.
- **Q-37 · Provider error text decides "Stopped" vs "Failed"** (`ExecutionActivity.tsx:72`).
  `/\bcancel(?:led|ed|ation)?\b/i` is matched against `attempt.detail`, which splices up to 500
  bytes of the endpoint's response body verbatim. Ollama is Go, so a dropped upstream connection
  yields *"context canceled"* → the UI tells the user **they** stopped the request when the backend
  died.
- **Q-38 · Runtime polls `/api/runtime` every 1–5s forever**, re-serializing the full model list,
  even when the tab is hidden.
- **Q-39 · Dead parameter.** `ConfigurableWebSearchProvider.search` never forwards `onAttempt` to
  the delegate (`:1102`), so `SearxngWebSearchProvider`'s `onAttempt` is unreachable.
- **Q-40 · No auth on the API.** Correctly documented as local-first, and browser CSRF is genuinely
  blocked (§6) — but any *non-browser* local process reads every conversation via
  `GET /api/conversations`. Worth stating plainly rather than letting "loopback-only" imply more.

---

## 5. Suggested order of work

1. **Q-04** — one missing `\s+`. A user forbidding the internet triggers the internet.
2. **Q-05** — reorder the vision branch; ordinary coding questions currently dead-end.
3. **Q-08** — the context cliff. Highest-volume user-visible failure.
4. **Q-06 + Q-13** — decouple the queue-wait cap from the caller's budget, and don't let warmup
   hold the slot before the port opens. Both currently persist fabricated answers as real history.
5. **Q-09** — retry discovery; a boot race silently makes a local-first install cloud-only.
6. **Q-03** and **Q-10** — strip bidi from titles; render a durable cloud disclosure at all
   verbosities.
7. **Q-14 + Q-15** — remember network denials across turns; stop treating "my current … schedule"
   as a public-web question.
8. **Q-18 + Q-02** — make the detector explainable and overridable *before* making it smarter. The
   false positives hurt more today than the false negatives.
9. **Q-01** — add message taint, or scope the README claim. Either is honest; the current state
   isn't.
10. **Q-07**, then **Q-27** / **Q-24** as cheap high-value quality wins.

---

## 6. What held up under testing — please don't refactor these away

Verified, not assumed. Several are load-bearing:

- **Private and Offline block web search** — 0 searches issued under both.
- **Sensitive requests stay local under Best quality** — verified with an `sk-` key.
- **Cloud is excluded from the post-search route and every fallback after a local attempt** —
  within the request (Q-01 notwithstanding).
- **The envelope validator is sound.** Nested tags, repeated tags, preamble/suffix, post-terminal
  records, visually-blank content all correctly rejected. No bypass found.
- **No ReDoS.** `PAYMENT_CARD_CANDIDATE_PATTERN` (`(?:\d[ -]*?){13,19}`) *looks* dangerous but is
  linear: 200,000 digits → **2.0 ms**; 180 KB of mixed digits/separators → **3.1 ms**.
- **DNS rebinding is blocked** — the `Host`-header check (`server.ts:119`) correctly rejects a
  rebound public hostname.
- **Browser CSRF is blocked** — *not* by the origin check, but because **no CORS headers are ever
  emitted**, so preflight fails for every JSON write and SOP hides every read. ⚠️ **Never add a
  permissive CORS plugin.** The origin check is defence in depth, not the actual control.
- **No XSS.** No `dangerouslySetInnerHTML` anywhere; `rel="noreferrer"` on external links;
  `safeResult` rejects non-HTTPS so `javascript:` can't reach an `href`.
- **API keys never leave the server.** Not persisted, not returned by `settings()`,
  `type="password"` in the UI, and the legacy purge does `secure_delete` + WAL truncate + `VACUUM`.
- **Closed panels are properly hidden.** `visibility: hidden` removes the execution panel and mobile
  sidebar from the tab order and a11y tree.
- **The settings dialog's a11y is genuinely good** — focus trap, Escape, `aria-modal`, background
  `aria-hidden`, focus restore. Best-executed code in the repo.
- **`describeCloudUsage` counts web search as cloud contact** and reads the append-only attempt
  ledger, so failed cloud contact can't be erased by a later local success.
- **`route-planner.ts:53` is correct** — independently probed; the private-mode cloud exclusion
  holds.

---

## 7. Investigated and dismissed — do not re-litigate

- **"Auto search fallback is defeated by the shared 8s deadline."** The shared budget is
  intentional (README:168) and locked by an existing test named *"uses one eight-second deadline
  across every Auto provider"* (`web-search-provider.test.ts:454`). Fallback works normally for
  every fast-failure mode — Exa 503-ing after 3s still falls through to Tavily successfully. Only a
  *black-holed* connection consumes the remainder. Optional improvement, not a bug: give each
  attempt a slice (remaining ÷ remaining candidates, floor ~2s).
- **"Session keys lost on restart silently kill web search."** The mechanism is real but it is not
  silent: the composer renders "Web search is not configured", the settings dialog shows
  "Exa · setup required" / "Needs setup" with a `role="alert"` and **Save disabled**, and any web
  request returns an explicit recoverable error. Recovery is re-typing one field. At most, reset a
  now-unconfigured stored provider back to `auto`.
- **Quantized model tags failing discovery.** False — Ollama returns quant tags verbatim in
  `/v1/models`, so `qwen3.5:9b-q4_K_M` matches when configured as pulled. The real over-strict case
  is the *omitted* tag (see Q-09).
- **`qwen3.5:9b` / `qwen3.5:2b` being fictional tags.** Checked against a live `ollama list` — both
  exist and are pulled. The quick-start instructions are correct.

---

## 8. Invariant test coverage — ANSWERED by mutation testing (2026-07-30)

The original pass produced nothing usable: the finder and its verifier were given contradictory
briefs (one was told missing tests count as findings, the other that they don't), and all five
results were discarded.

**Answered instead by mutation.** Reading tests cannot tell you what they enforce — a test can
name an invariant in its title and still pass when the invariant is deleted. So each of the 13
invariants in `docs/architecture.md` was broken *in the source*, the full suite was run, and the
invariant counts as enforced only if something turned red.

| # | Invariant | Mutation applied | Result |
| --- | --- | --- | --- |
| I-1 | Policy tightened, never weakened | `allowCloudModels: false` → `true` in `policies.ts` | caught (3) — see note |
| I-2 | Sensitive classification excludes cloud | drop the `requiresLocalProcessing` filter | caught (3) |
| I-3 | Web-grounded history excludes cloud | (same filter) | caught (3) |
| I-4 | Offline excludes loopback too | drop the transport filter | caught (2) |
| I-5 | Provider registered only when discoverable | force `available: true` | caught (1); a second mutation removing the install filter caught 4 |
| I-6 | Local URL must be loopback | short-circuit `normalizeLoopbackBaseUrl` | caught (6) |
| I-7 | Cloud URL must be HTTPS | short-circuit `normalizeCloudBaseUrl` | caught (6) |
| I-8 | Policy cloud exclusion is not a preference | drop the `location === "cloud"` filter | **SURVIVED** → fixed |
| I-8b | Cloud absent without credentials | register cloud unconditionally | **SURVIVED** → fixed |
| I-9 | Conversation storage is local | — | structural (see below) |
| I-10a | Client role not authoritative | trust `submittedUserMessage.role` | caught (3) |
| I-10b | Client message id not authoritative | trust `submittedUserMessage.id` | caught (5) |
| I-10c | Client timestamp not authoritative | trust `submittedUserMessage.createdAt` | caught (3) |
| I-10d | Running/empty history filtered out | drop the `trustedHistory` filter | caught (2) |
| I-11a | Privacy guard blocks web search | disable the sensitive-data check | caught (3) |
| I-11b | Policy gates web search | disable the `allowNetwork` check | caught (3) |
| I-12 | Disclosure derived from the actual plan | emit a synthesis step unconditionally | caught (20) |
| I-13 | Loopback API is not an auth boundary | — | not yet buildable |

**I-1 needs a note, because "caught" overstates what was catching it.** An independent reviewer
re-ran the mutation and got 3 failures, not the 8 recorded here — a miscount on my part. More
importantly, of those 3, the only *pre-existing* catch is an API test asserting on the
**system-prompt inventory**: what the model is told about itself, not where requests route. The
585-test core routing suite did not catch it at all. So before this branch, "policy may be
tightened, never weakened" was enforced at routing level by nothing, and the new private-mode test
is the first routing-level catch. It belongs closer to the two failures below than the table
suggests.

Related: the `it.each(["private", "offline"])` in the new test is misleading. Only the **private**
row exercises the cloud filter — with that filter deleted the offline row still passes, because
the transport filter (I-4) independently excludes a remote model. The offline row is a genuine
assertion but it does not test what its placement implies.

**Two invariants were enforced by nothing.** Both are now pinned by tests that were themselves
verified against the mutation — written, confirmed red, then reverted.

*I-8* is the more interesting failure. A test named for private mode existed and passed, but its
cloud model was rated 90 against a local model rated 60, and `preferLocal` adds a flat +100. The
cloud model lost on **sorting arithmetic**, not on policy, so deleting the policy filter entirely
left the suite green while private-mode requests routed to cloud. This is the general shape of the
danger: a test whose fixture makes the wrong answer unreachable tests nothing, however it is named.

**And the replacement had the same defect.** The new fixture rated the cloud model 195, and this
section originally stated that it "can only pass if the filter actually runs." That was reasoned,
not tested. `localScore` is `(local ? 100 : 0) + qualityRating + 18 per matched specialty + 20 for
freshness`, so local's worst case is `100 + 60 + 18 + 20 = 198` — *above* 195. The fixture passed
only because that file's request happens to ask for no specialties and no freshness. A later
change to the request, or a specialty added to the local model, would have silently returned the
suite to green whether or not the filter existed.

It is now rated 300, which clears local's true ceiling of 288 for **any** request rather than for
that one, and a guard test asserts the margin directly so the next erosion fails loudly.

The way it surfaced is the point: the guard went red on its first run, against a value already
committed with a paragraph explaining why it was sufficient. Reasoning about the number produced
the wrong answer; writing the check produced the right one in seconds. §16 records five instances
of this same shape found during the extraction review — a mechanism that *would* explain something
mistaken for evidence that it *does*. This is the sixth, and it is the one that occurred inside the
test written to prevent it.

*I-8b* is simpler and worse. Changing `config.ts` to register the cloud provider while ignoring
the API key left **all 136 API tests passing**. A cloud model would then enter the registry, be
selectable by the planner, and fail only at request time — or send unauthenticated requests to a
real endpoint. Pinned in `apps/api/src/security-invariants.test.ts`, which also covers the blank
key, since a key set to whitespace is a misconfiguration rather than consent to egress.

Two invariants have no test because neither is a claim a test can currently falsify. **I-9** holds
by construction: the only storage backend is `better-sqlite3` against a filesystem path, so there
is no remote path to accidentally take. It becomes testable the moment a sync or backup target is
added, and should get a test then. **I-13** concerns the per-launch secret in the desktop sidecar,
which does not exist yet; the invariant is a design commitment, not current behaviour. Note that
its precondition — the API stays on loopback — *is* now tested, since a non-loopback `HOST` must
fail closed at startup for the rest of the claim to mean anything.

**I-11 deserves a caveat.** Both guards are caught, but they run before generation, against the
compiled request. That is the right shape — the invariant asks for authorization *outside* model
output — yet it holds today partly because no model in this codebase can request a tool at all.
When model-driven tool calls arrive, these tests will not be sufficient, because they never
exercise the path the invariant is really about.

### Two claims this section originally made were themselves wrong

The first version of this section closed by repeating two coverage gaps inherited from the
discarded original pass. Both were later put through the same mutation discipline as everything
else. **Both are false.**

| Claim as originally written | Mutation applied | Actual result |
| --- | --- | --- |
| "`inference-scheduler.test.ts` never passes `maximumWaitMs`, so Q-06's cap is untested" | make `acquire` ignore `maximumWaitMs` | caught (2) |
| "no test asserts the cross-turn behaviour in Q-01" | force `containsWebGroundedData` to `false` | caught (2) |

The scheduler cap is covered by *"honors an explicit caller wait budget instead of clamping it to
the default"* and *"reports the wait duration that it actually enforces"*. They pass the budget
**positionally** — `scheduler.acquire(undefined, 50)` — so the identifier `maximumWaitMs` never
appears in the test file and a grep for the parameter name returns nothing. The claim was
manufactured by searching for a name against a positional call.

This is left in rather than quietly deleted, because it is this section's own thesis turning on its
author. §8 exists to argue that **reading tests cannot establish what they enforce** — and then
closed with two gaps established by reading. The mutation discipline was applied to thirteen
invariants and skipped for the two claims that arrived pre-written. An inherited finding needs the
same treatment as a new one; carrying it forward is a citation, not a verification.

Corrected position: **no invariant in `docs/architecture.md` is currently known to be unenforced.**
The two that are not falsifiable (I-9, I-13) are recorded above as such, and I-11's caveat stands.

---

## 9. Network development gateway — review of `fix/network-dev-password-ux` (2026-07-30)

Separate review, separate surface: the LAN development gateway added after the original pass, plus
the insecure-context fallbacks it made necessary. Three lenses (security/exposure, runtime
correctness, layout/a11y/docs) against HEAD `f6915f3`. IDs continue the existing sequence.

**All findings below marked FIXED were remediated in `883cd88` and `f6915f3`, and each fix was
verified by re-running the probe that found it.** Baseline moved from 664 to 754 tests.

### Fixed

| ID | Finding | Evidence |
| --- | --- | --- |
| **Q-41** | Vite's HMR WebSocket never traverses the auth middleware — it attaches to the raw `upgrade` event. [CONFIRMED] | Unauthenticated LAN handshake returned `101 Switching Protocols` + `{"type":"connected"}`. Now bound to loopback; no upgrade. **This fix alone introduces Q-53 — apply both.** |
| **Q-42** | The README's example password *was* the live credential, with an 8-char floor and no backoff. [CONFIRMED] | 20,619 failed guesses/sec measured; no lockout after 200 failures. Now a placeholder, 24-char floor for configured passwords, 250 ms rejection delay (measured 0.266 s). |
| **Q-43** | The proxy rewrote every inbound `Origin` to loopback, laundering hostile origins past the API's own check (§6 calls that check load-bearing). [CONFIRMED] | `Origin: https://evil.example` → `201 Created` through the proxy vs `403` direct. Now `403` through the proxy; own origin still `201`. |
| **Q-44** | `/@fs` served `var/quorum.db` — the conversation history — to any authenticated client. [CONFIRMED] | `200` before, `403` after. Vite's default `deny` entries had to be restated, since naming `deny` replaces them. |
| **Q-45** | Vite answers CORS preflights before plugin middleware, so `OPTIONS` was unauthenticated. [CONFIRMED] | `204` before, `401` after (`cors: false` in network mode). |
| **Q-46** | `npm run dev -w @quorum/web -- --host` bypasses `scripts/dev.mjs` and its argument guard entirely, yielding an unauthenticated server on `0.0.0.0`. [CONFIRMED] | Reproduced with `--port 5199` to dodge the port collision; now refused at server start by a loopback-only plugin. Plain `--port 5199` still serves on `127.0.0.1`. |
| **Q-47** | The `execCommand` clipboard fallback was a silent no-op on WebKit (`select()` alone leaves the selection empty on a readonly textarea) and could report false success. [CONFIRMED] | 4 of 8 new tests in `clipboard.test.ts` fail against the pre-fix module. Also fixed: `position: fixed` with no offsets, `append`/`select` outside the `try` leaking an attached textarea, and stolen focus. |
| **Q-48** | A live region nested inside a `<button>` is not reliably announced — `button` is Children Presentational. [PLAUSIBLE] | Status moved to a sibling `role="status"`; failures now persist until the next attempt rather than clearing on the success timer. |
| **Q-49** | The execution panel overlaid 83% of a 360px screen with no scrim, and the composer's send button stayed tappable behind it. [CONFIRMED] | `elementFromPoint` returned `.composer-actions` through the panel. Scrim now renders for either drawer. |

### Deferred — pre-existing on `main`, not introduced by this branch

**Q-50 · Topbar controls clipped and unclickable at 841–1122px [CONFIRMED]**
`apps/web/src/styles.css:277-280`. `.main` declares `grid-template-rows` but no
`grid-template-columns`, so its implicit `auto` track sizes to max-content (553px) and overflows
its grid cell, which `.main`'s `overflow: hidden` then clips. It bites on first paint because
`executionOpen` initialises `true` at ≥841px. Measured: at 900px the Inspect button is not merely
covered — `elementFromPoint` over its rect returns the execution panel, so it is unpainted and
unhittable. Affects a half-screen window on a 1080p monitor and 1024px tablets in landscape.

Fix needs two parts: `.main { grid-template-columns: minmax(0, 1fr); }` constrains the track, but
the ≤560px compaction rules must then key off *available* width rather than viewport width
(container query on `.main`, or duplicate them under `@media (max-width: 1120px)` for
`.execution-visible`). Deferred because the second part is larger than this branch should carry.

**Q-51 · No focus management or Escape handling for either drawer [CONFIRMED]**
`apps/web/src/App.tsx:560-568`, `767-780`. Opening a drawer leaves focus on the trigger. The
sidebar precedes the trigger in DOM order, so Tab moves *forward* into the topbar and composer —
content that is behind the scrim, dimmed, and pointer-blocked. Keyboard and screen-reader users can
therefore operate controls mouse users cannot reach. `Escape` is handled only in
`SettingsDialog.tsx:125`. Fix: focus the drawer's first control on open, handle Escape, and mark
the rest `inert` while a drawer is open. (Off-screen drawers *are* correctly hidden from assistive
tech already via `visibility: hidden` — verified, no finding there.)

### Notable non-findings from this pass

- **The ≤841px track-count change does not glitch.** Probed directly: a 3-track → 1-track change
  creates **zero** animations, and the computed value is final on the first recalc after crossing
  the boundary. The *old* rule was the interpolable one — it animated smoothly into the broken
  zero-width state. The `transition: grid-template-columns` on `.app-shell` is simply inert below
  841px.
- **The credential comparison has no bypass.** Full-header byte comparison with a length check
  gating `timingSafeEqual`; casing, whitespace, unicode, and base64 variants can only make it fail.
- **No production-build leakage.** `development-auth.ts` is imported only by `vite.config.ts` and
  its test; both the auth plugin and the network proxy are gated on `mode === "network"`, which
  `vite build` never sets.
- **Dropping `...process.env` from the concurrently child env is not a PATH regression** —
  `getSpawnOpts` merges `process.env` before spawning. Checked because it reads like a breakage.
- **A test file named `vite.config.test.ts` never runs.** Vitest's default `exclude` drops
  `**/vite.config.*`. The config tests live in `apps/web/src/network-server.test.ts` for that
  reason; renaming them back would silently disable them.

---

## 10. Local answers are destroyed by their own length limit (2026-07-30)

Found from a live user report, not a sweep: a coding question on a phone returned "qwen3.5:9b
returned no valid structured public answer" and fell through to the scaffold responder.

### Q-52 · Any local answer that exceeds the verbosity cap is discarded whole [CONFIRMED]

`apps/api/src/openai-compatible-provider.ts:563` (parse) versus `:569-572` (truncation notice).

The native Ollama path sends `format: PUBLIC_ANSWER_SCHEMA` with `num_predict: maxOutputTokens`,
accumulates the stream into `structuredContent`, then `JSON.parse`s the whole thing. Schema-
constrained decoding guarantees well-formed JSON *only if generation runs to completion*. When
`num_predict` stops it first, the object is cut mid-string and the parse throws `unsafe_output`,
so the entire answer is thrown away.

The caps are small — `VERBOSITY_OUTPUT_LIMITS` at `:83-87` is concise 384 / standard 768 /
detailed 1536 — and `standard` is the default, so this is reachable by ordinary questions.

Reproduced directly against Ollama at the exact cap the reporting user was on:

```
num_predict=120  done_reason=length  len=640   validJSON=false   tail: "...often misunderstood concepts in"
num_predict=768  done_reason=length  len=4142  validJSON=false   tail: "...used in relational database management"
```

4,142 characters of usable answer produced, zero delivered.

The bug is an ordering one, and the intended behaviour is already written: `truncationNotice`
(`:377-382`) composes "reached Quorum's N-token response limit. Ask Quorum to continue if more
detail is needed," and `streamOllamaResponse` computes `truncated` from `done_reason === "length"`
at `:548`. Both are unreachable on this path, because the parse at `:563` throws before the check
at `:569`. Truncation is handled *after* the step that truncation breaks.

Distinct from **Q-05**, which dead-ends coding questions via `VISION_PATTERN` routing. Here routing
was correct — the trace read "received this as a coding request" — and the loss happened at output
validation.

**Deliberately not fixed without a decision.** §6 lists the public-answer envelope and its
validation as load-bearing, with an explicit request not to refactor them away, and every plausible
remedy touches that boundary:

1. *Salvage the partial string.* Closest to the existing intent, and makes `truncationNotice`
   reachable — but it means accepting output that failed the structured check, which is exactly the
   boundary §6 protects. Would need to salvage only the `answer` string of an otherwise well-formed
   prefix, never a partial escape sequence, and still run `hasVisibleContent`.
2. *Raise the caps.* Cheapest, strictly a mitigation; a long enough answer still falls off the same
   cliff, and the input budget at `:695` shrinks to match.
3. *Ask for less.* Have the system prompt target the cap so the model lands inside it. Does not
   bound anything, since compliance is advisory.

(1) guarded as described is the recommendation, plus (3). The failure is currently silent about its
own cause — the user is told the answer was invalid, not that it was too long, which is the one
piece of information that would let them ask for less detail and succeed.

---

## 11. Regression caused by the Q-41 fix — read this before applying it

### Q-53 · Binding hot reload to loopback makes the public port crashable [CONFIRMED]

`apps/web/vite.config.ts`. **Introduced by the fix for Q-41, found in production use within
minutes of shipping it, fixed in `846a6be`.** Anyone applying the Q-41 remedy on its own will
reintroduce this, which is why it is recorded rather than quietly folded into Q-41.

Moving the HMR socket to its own loopback server closes the unauthenticated broadcast channel, but
it also leaves WebSocket upgrades on the public port with no owner. Vite accepts the socket, no
listener consumes it, and none of them attach an `error` handler. A peer that resets such a
connection therefore raises an unhandled `ECONNRESET`, which terminates the Vite process; the
`concurrently` supervisor then SIGTERMs the API, taking the whole stack down.

So the Q-41 fix converts an information disclosure into a **remote denial of service reachable by
any unauthenticated LAN client** — strictly worse. Observed twice against the live server:

```
[web] Error: read ECONNRESET
[web]     at TCP.onStreamRead (node:internal/stream_base_commons:216:20)
[web] Emitted 'error' event on Socket instance at: ...
[web] npm run dev:network -w @quorum/web exited with code 1
--> Sending SIGTERM to other processes..
[api] npm run dev -w @quorum/api exited with code 1
```

Two properties made this easy to misdiagnose, both worth remembering:

- **The crash is delayed.** It lands when the client's socket resets, not when the upgrade is sent.
  An immediate "is it still up?" probe returns 200 and reads as proof the fix is safe. It is not.
- **The first occurrence looked self-inflicted.** It coincided with a second Vite instance started
  on another port to test Q-46, which re-optimised the shared `node_modules/.vite` cache — a
  plausible enough culprit to stop the investigation early. Only the second, clean reproduction
  ruled it out. A tidy explanation that arrives before the evidence does is worth distrusting.

**Fix:** register an `upgrade` listener in network mode that attaches an error handler and destroys
the socket, so unowned upgrades are closed deliberately instead of left dangling
(`rejectNetworkUpgradesPlugin`). Nothing legitimately upgrades on that port once HMR has its own
server; a future `ws://` proxy entry would have to be excluded explicitly.

**Verification that actually settles it:** send several upgrade-then-reset probes and confirm the
server still serves afterwards, with a delay long enough to cover the late reset. Five probes kill
the server before the change and leave it serving after. `src/network-server.test.ts` asserts the
plugin is installed, which catches removal but not behaviour — the socket-level check has to be
done against a running server.

---

## 12. Web search never fires for "which model is best" (2026-07-30)

From a live user report: a conversation designing a hub-and-spoke agent reached *"So qwen3.5:9B is
the best spoke publicly available?"* and Quorum answered about "the broader public market of
open-weight models" entirely from model weights, with no search and no disclosure that it had not
checked.

### Q-54 · Freshness needs a closed subject vocabulary that omits `model` [CONFIRMED]

`packages/core/src/request-compiler.ts:19-28`, reached from `classifyPrompt` at `:317-321`.

`requiresFreshness` is true only when a time word (`latest|recent|live|current(ly)|today|this
week|up-to-date`) co-occurs with a subject from a **closed list**:

```
news | events | laws | regulations | prices | weather | versions | releases
| exchange rates | schedules | scores | officeholders | presidents | ceos
```

`model` is not on it. Probed through the real `RequestCompiler`:

```
intent=conversation  fresh=false  :: So qwen3.5:9B is the best spoke publicly available?
intent=conversation  fresh=false  :: What is the best publicly available model right now?
intent=conversation  fresh=false  :: What is the state of the art open weight model?
intent=research      fresh=true   :: What are the latest model releases?
intent=research      fresh=true   :: What are the current model prices?
intent=research      fresh=false   :: What is the best publicly available model? search the web
```

Three separate gaps, in order of how much they matter:

1. **`model` is absent from the subject vocabulary.** In an application whose entire domain is
   choosing between AI models, "which model is best" can only reach the web by naming `releases`,
   `versions`, or `prices`. Rows 4 and 5 above pass for exactly that incidental reason.
2. **Superlatives are not freshness signals.** `best`, `state of the art`, `top`, `leading` assert
   a present-tense ranking, but the pattern requires a time adverb, so none of them qualify.
3. **`right now` is not in the time-word list**, though `current` and `today` are — row 3 fails
   despite being explicitly scoped to the present.

Worth stating plainly: the answer was not merely stale, it was **undisclosed**. The user cannot
tell a searched answer from a remembered one, so a confident paragraph about "the broader public
market" reads as current.

**Do not simply widen the vocabulary.** §3 **Q-15** is the counterweight: `schedules`/`prices` are
already generic enough that *"What is my current medication schedule?"* acquires `web` and the
literal sentence leaves the device. Loosening the trigger with superlatives would extend that
egress path to anything phrased as a comparison.

**Recommended shape — gate on an explicit public-scope marker instead of on more nouns.** Phrases
like `publicly available`, `on the market`, `open[- ]weight`, `open source`, `available today`
assert a *public* subject, which is precisely the case Q-15's personal-possessive risk does not
cover. A superlative plus a public-scope marker is a safe freshness signal in a way that a
superlative alone is not; the user's own sentence contains one. Adding `models?` to the subject
list is defensible on its own and narrower than it looks, but only the public-scope gate addresses
"state of the art" and "best on the market" without reopening Q-15.

Whatever the trigger, the **disclosure gap should be closed independently**: when a question looks
like a present-tense factual ranking and no search ran, the answer should say the claim comes from
training data rather than from the live web. That is useful even if the classifier is left exactly
as it is.

**Not fixed** — this changes a privacy boundary that §6 and Q-15 both bear on, so it wants an
explicit decision rather than a quiet patch.

---

## 13. Relay orchestration — pre-merge red team (2026-07-30)

Three lenses against `feat/orchestration-relay` before merge: egress/taint/injection, orchestrator
failure paths, and planner/disclosure honesty. Nine defects found and fixed on the branch,
including one introduced *by* a fix earlier in the same session. What follows is what remains.

**The egress boundary held.** Canary strings planted in search snippets were asserted absent from
every cloud invocation across four configurations — post-search happy path, spoke failure, a
four-deep local failure chain, and the case where the cloud model was the only healthy provider.
Zero cloud invocations in all four. Prompt injection through the draft found no escape: JSON
breakout, forged frame closers, NUL, ANSI and bidi payloads all round-trip as inert data inside
the per-request UUID frame.

One correction to how the guarantee is often described, worth keeping because the next change will
depend on it: the protection is **not** primarily "both stages are planned up front." It is the
conjunction of `#selectHub` hard-requiring a local model, and the fallback re-plan excluding cloud,
which holds only *inductively* — it excludes cloud when the failing provider is local, and
post-search every attempt is local because the initial plan was. **If a cloud hub is ever allowed,
that induction breaks and the fallback re-plan becomes the exposed edge.**

### Q-55 · A relay turn can sit idle for two full generations [CONFIRMED]

`packages/core/src/orchestrator.ts` (draft loop), `apps/api/src/server.ts`. The draft is withheld
by design, so between `trace:model:running` and `trace:model:completed` the client receives no
events at all. Note the structured provider already buffers a whole answer before its single
yield, so route mode has one generation of silence; relay has two.

Mitigated, not eliminated, by the SSE keep-alive comment now written every 15s. That keeps the
socket alive behind proxies that time out idle connections (nginx defaults to 60s) but does not
improve time-to-first-byte, which under relay is draft generation plus hub prefill. Real streaming
would require yielding the draft as a distinct event kind the client renders as progress rather
than as answer text.

### Q-56 · Scheduler contention silently turns relay into route [CONFIRMED]

`apps/api/src/inference-scheduler.ts` (concurrency 1, maximumQueue 8). Relay takes two sequential
slots per request. A rejected hub acquire raises `ModelExecutionError` kind `"request"`, which is
correctly exempt from the circuit breaker and correctly attributed to the spoke — but the only
surface saying synthesis did not happen is the rationale suffix. On a busy instance relay becomes
route-with-extra-latency with no explicit signal. A `synthesisDegraded` flag on the plan would be
cheaper than expecting the rationale to be read. Also note the queue now admits half as many
concurrent requests as it did under route.

### Q-57 · Fallback costs one full draft per failing spoke [CONFIRMED]

`orchestrator.ts`, the `attemptContent && !drafting` guard. Terminating is not in question —
`excludedModelIds` strictly shrinks the candidate pool and five emit-then-fail spokes produced
exactly five attempts before settling. The cost is: route mode stopped falling back at the first
emitted token, so a mid-stream failure cost one *partial* generation; relay costs one *full*
generation per physically-distinct local model. A cap of two draft retries would bound it without
changing the semantics.

Worth recording because it looks alarming and is correct: when every model emits-then-fails, relay
degrades to route as the general pool empties, and at the moment no hub remains the pre-existing
"stop once output began" guarantee resumes and the user gets the partial. That seam works.

### Q-58 · An empty hub response can take the general model out of route service [PLAUSIBLE]

`orchestrator.ts`. `"<label> returned no response content."` is thrown as a plain `Error`, so it
is treated as a provider failure and records against the circuit. Two consecutive empty hub
responses flip the general model to `available: false` for 30s, and because the breaker is keyed
by physical identity that also blocks plain `route` requests to the same model.

Sharing the circuit is right for genuine endpoint failure — both stages dial the same endpoint,
and when it opens `#selectHub` declines to relay so the request runs as plain route, which is
verified to work. The questionable case is specifically the empty response, which is model
behaviour rather than endpoint health. Making that a `ModelExecutionError` of a non-provider kind
would fix it, but the drafting stage shares the wording and would have to change with it.

### Fixed on the branch, listed so they are not re-litigated

Offline mode planning a loopback hub (the hub was selected from the raw model list, bypassing
policy, capability and transport filters). The panel naming the hub as the model used when the
hub failed and the spoke's draft shipped — twice, since the first fix covered the degrade path but
not the cancellation path. A failing hub never opening its circuit while hub successes cleared the
counter. Cancelling during synthesis discarding a finished draft. Three surfaces attributing a
cloud spoke's work to the local hub, one of them writing that claim into the append-only ledger.
Relay degrading with no signal in the rationale. The hub chosen by declaration order rather than
rank. The drafting stage falling back to `plan.modelId`, which is the hub. A synthesis step naming
an unregistered model swallowing the draft and delivering an empty answer.
