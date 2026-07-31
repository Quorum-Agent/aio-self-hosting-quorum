# ADR 0002: Capability graph, model slots, and provider attributes

- Status: Proposed
- Date: 2026-07-31
- Supersedes: the flat `LocalModelRole` model implied by `docs/architecture.md`

## Context

Quorum routes requests to local models by **role**: `general`, `coding`, `reasoning`.
Three roles, one model each, all assumed to be the same kind of thing.

That model cannot express what the product already needs, and the existing target
capability graph in `docs/architecture.md` already says so without the code following.
Three of its eight nodes are **compound** — "OCR / document parser", "retrieval +
reranker", "speech pipeline" — each naming several distinct operations in one node. The
graph has implied a two-level structure since it was written; only the type system is
flat.

Three concrete symptoms of the gap, all verified in source:

- **`vision` is declared and served by nothing.** A capability the compiler can require
  and no provider can satisfy, so an image request routes to the scaffold with no
  explanation. The app cannot say "I can extract text from this but not describe it,"
  because a capability is present or absent with nothing in between.
- **`tools` occurs exactly once in the repository — its own type definition.** Nothing
  declares it, nothing requires it. It was reserved for a level of the design that was
  never built.
- **The prompt analyzer and the entire validation layer are unmodelled.** Both are real,
  load-bearing subsystems doing recognisable domain work, and neither appears in the
  capability vocabulary, so neither can be routed to, substituted, or reasoned about the
  way a spoke can.

`Capability` is carrying three different levels of meaning at once: `chat` is a domain,
`documents` is a domain, `vision` is closer to a domain, `web` is a *provider kind*, and
`tools` is an operation that does not exist. That is why two of its seven values are
inert.

## Decision

Model the capability graph as four distinct concepts.

**Domain** — the work being done, from the user's point of view. Conversation, code,
documents, speech, and so on. Domains are stable and few.

**Slot** — a discrete operation, identified by **(operation × IO signature)**. This is
not simply "a sub-domain", and the distinction is load-bearing.

Two taxonomies are in play and they run on different axes. Intent taxonomies (what the
user wants done — "read this receipt", "explain this code") are what the classifier
resolves. IO taxonomies (what shapes a model consumes and produces) are what determine
which providers *can* fill a slot. Hugging Face's 47 maintained task tags are the latter:
`image-text-to-text` is a single tag covering OCR, visual question answering, chart
reading and screenshot understanding — four intents, one signature.

A slot sits at the intersection. That is why OCR and text extraction are siblings — same
output shape, different provider kind — and why one vision-language model can fill slots
that serve several unrelated intents.

**Provider** — what fills a slot. A model, a **deterministic library**, a remote peer, or
nothing. This is the level the current design most lacks: a PDF text extractor is
`pdfplumber`, not a model — zero VRAM, no load failure, no quality axis — and it belongs
beside an OCR model in the same domain. Two provider shapes exist today
(`ModelProvider`, `WebSearchProvider`); a deterministic-transform shape is the missing
third.

**Attribute** — how a provider behaves while filling a slot, as distinct from which slot
it fills. Alignment, prose style, language bias, licence. Two models can fill the same
slot and be chosen between on these grounds.

### Which slots Quorum offers

A slot is offered when **both** hold:

1. a distinct model class genuinely exists for it, and
2. it is a distinct *operation* rather than a disposition toward an existing one.

Both halves are required. The first alone admits creative and uncensored finetunes, which
are unambiguously a distinct model class — but they are post-training applied to a
generalist to remove guardrails or bias prose, serving the **same** operation. They are an
attribute, not a slot. (An earlier draft of this ADR used only the first test and reached
the wrong answer; the second clause exists because of that.)

Offered:

| Slot | Distinct model class | Notes |
| --- | --- | --- |
| Code | Qwen-Coder, DeepSeek-Coder, Devstral | Served today |
| Deep reasoning / math | R1 distills, QwQ, DeepSeekMath, Qwen-Math | **Not** the current `reasoning` role — see Consequences |
| Document understanding | Qwen-VL, PaddleOCR-VL, dots.ocr | `image-text-to-text`. Measured: `document-question-answering` has **1** GGUF, so OCR is not its own supply category — it lives inside VLMs |
| Text extraction / parsing | *(library, not a model)* | The case that motivates the provider level |
| Vision | Qwen-VL, InternVL, moondream | Official VLMs; no finetune scene |
| Speech to text | Whisper, Parakeet | Small, co-resident |
| Text to speech | Piper, Kokoro | Weakest quality-to-effort ratio of the set |
| Audio understanding | Voxtral, Qwen2-Audio, Ultravox | `audio-text-to-text` — the exact parallel of vision's `image-text-to-text`. **Not** transcription: answers questions *about* audio (genre, speaker affect, what a sound is) that ASR cannot |
| Embedding | nomic-embed, mxbai, bge | Service role, never a chat model |
| Reranking | bge-reranker, Qwen3-Reranker | Distinct from embedding; commonly conflated |
| Safety / verification | Llama Guard, ShieldGemma, compliance finetunes | 274 GGUF `text-classification` models. **Distinct from Quorum's coded validation layer** — see below |

Not offered, with reasons:

- **Conversation and general reasoning** — the generalist *is* the state of the art. A
  spoke would be worse than the model already in the general slot.
- **Translation** — *provisionally* not offered, and this is the least settled exclusion in
  the list. A generalist covers general translation and the observed demand is niche, but
  there are **485 GGUF translation models**, which is more supply than the exclusion
  comfortably explains. Revisit if a concrete demand signal appears.
- **Creative / uncensored** — an attribute (above). Quorum should make it *possible* to
  point the general slot at such a model and have routing, policy and disclosure work
  normally; it should not build a domain around it, and it should not attempt to compete
  with the dedicated front-ends that own that use case.
- **Agents / computer interaction / video** — need plumbing before a model choice means
  anything. No tool-calling loop exists (see the `tools` symptom above).
- **Generative media** — excluded for a *product* reason, not a supply one: 424 GGUF
  `text-to-image` models and a healthy `text-to-audio` population (ace-step, stable-audio,
  thinksound) mean this is locally runnable. Quorum has no path for producing an image or
  an audio clip as an answer. The blocker is the message model, not the ecosystem.
- **Audio source separation and music information retrieval** — real and locally runnable
  (Demucs, BSRoformer; chord, beat and piano-transcription models), but they are
  media-production tools rather than answers to a prompt. Separation has no return path,
  for the same reason as generative media. MIR does produce symbolic output Quorum *could*
  return, and is excluded on demand rather than on shape — the weaker of the two reasons.

### The domains, derived from the slots

The domain list is derived **from** the slots rather than the reverse. The originating
taxonomy for this ADR was top-down from a single unvalidated source; slots are the axis
with measurable supply behind them, so deriving upward makes the domain list a consequence
of things that can be checked.

| Domain | Slots | User-visible? |
| --- | --- | --- |
| Conversation | general | yes |
| Code | code | yes |
| Documents | document understanding, text extraction | yes |
| Vision | vision | yes |
| Audio | speech to text, text to speech, audio understanding | yes |
| Analysis | deep reasoning / math | yes |
| Knowledge | embedding, reranking | **no — infrastructural** |
| Verification | safety / verification | partly |

Eight domains, eleven slots — which is what "stable and few" has to mean to be worth
asserting.

**Domains are named by modality, not by use.** An earlier draft named this domain *Speech*,
which is a use *within* audio, while naming its neighbour *Vision*, which is a modality.
That inconsistency is not cosmetic: it hid a slot. Vision was given an
`image-text-to-text` understanding slot and audio was not, because "speech" does not
prompt the question. Naming both by modality makes the asymmetry visible.

**Not every slot is a decision an operator should have to make.** Knowledge is the clear
case: a user asks to search their notes, never to select a reranker. Embedding and
reranking are infrastructural — real slots, substitutable, but they belong behind a
sensible default rather than in front of the operator. Verification splits: Quorum's own
output validation is infrastructural, while checking a procedure against a regulatory
corpus is something a user asks for deliberately.

This partly answers the configuration-surface objection recorded below. The surface is not
ten decisions; it is closer to six, with the rest defaulted and overridable.

### Slots are not uniform in cost

A flat role list assumes every spoke competes for the same budget. Slots do not:

- a text parser costs nothing and never fails to load;
- an embedding, reranking, OCR or STT model is sub-1 GB and co-resides freely;
- a deep-reasoning or code model is 4–30 GB and contends for residency.

Treating these as one class is why "how many spokes" felt unanswerable — it was one
question about three cost classes.

## Consequences

**The existing `reasoning` role is replaced, not renamed.** Its current meaning is "a
model that is good at reasoning", which a modern generalist with a thinking toggle
already covers — the ecosystem has folded that capability into generalists as a setting.
The new slot means extended deliberate computation: thousands of tokens, materially
better at proofs and multi-step mathematics, a genuinely different model population.

**This is a migration hazard and must be handled explicitly.**
`QUORUM_LOCAL_REASONING_MODEL` is live configuration with test coverage. Silently
redefining the role would route deep-reasoning traffic to whatever model an operator
already configured, which will not be an R1-class model. The new slot therefore takes a
**new setting name**; the old one is either honoured as a generalist alias or fails
closed with a message naming the change. It must not be reinterpreted in place.

**Deep reasoning needs its own inference profile, not just its own model.** Reasoning
tokens are drawn from the same budget as the answer — measured on the pinned build, a 4B
model spent 712 characters of thinking on a one-word request. The slot needs a much
larger `maxOutputTokens` and longer timeouts than the general slot. Both are already
per-model (`ModelInferenceSettings`, `ProviderTimeouts`), so this is expressible today.

**Its routing cost is asymmetric.** Misrouting to a coding spoke wastes a second;
misrouting to a deep reasoner wastes minutes. This is the slot most exposed to classifier
error, and the classifier has a documented history of misroutes (Q-04, Q-05). Routing
into an expensive slot should require stronger evidence than routing into a cheap one.

**Partial service becomes expressible, and should be surfaced.** With slots, "I can OCR
this but not describe the scene" is a statable answer. Today that request dead-ends into
the scaffold, which reads as a model-quality failure rather than a missing capability.

**Slot count is a product decision, not a hardware one.** With the `network` and `remote`
tiers from ADR-adjacent work, a slot's provider may live on another machine. What one
operator can run concurrently is a deployment question and does not bound what Quorum
offers.

## Alternatives considered

**Keep the flat role list and add roles.** Rejected: it is what produced two inert
`Capability` values and an unservable `vision`. Adding `ocr`, `stt`, `embedding` as peers
of `general` would repeat the conflation at larger scale, and still could not express a
library as a provider.

**Model slots but not attributes.** Rejected: without an attribute level, "the uncensored
one" has to be encoded as a capability or a specialty, and `specialties` is typed
`Capability[]`. That is precisely the mistake found and fixed when a web-search tool was
being described with a vocabulary meant for inference locations.

**Treat retrieval as a model slot.** Rejected: RAG is a pipeline over the generalist
(embed → retrieve → rerank → generate), not a chat specialist. The slots it needs —
embedding and reranking — are offered individually; "a RAG model" is not a thing to
select.

---

## Pressure-test record

Per the working rules in `CLAUDE.md`, this artifact was tested before and after drafting.
Findings applied inline are marked; limitations that remain are registered here rather
than resolved.

### Before drafting — assumptions tested

- **"The existing capability graph is flat."** *Falsified.* Three of its eight nodes are
  already compound. **Applied:** the ADR now presents this as making an existing implication
  explicit rather than as a new design.
- **"A distinct model class exists" is a sufficient criterion.** *Falsified.* It admits
  creative and uncensored finetunes, which are excluded on other grounds. **Applied:** the
  criterion gained a second, required clause.
- **Redefining `reasoning` is safe.** *False.* It is live configuration with tests.
  **Applied:** promoted to an explicit migration consequence requiring a new setting name.
- **"Distributed spokes make slot count unbounded."** *Overstated.* Peer discovery is not
  built; only manual configuration exists, and each peer is hardware someone must own.
  **Applied:** softened to "slot count is a product rather than hardware decision", which
  is the defensible form.

### After drafting — red-team lens

- **The originating 14-domain taxonomy was one unvalidated source** — a chat with no
  project context. Partially addressed: the slot list has since been checked against
  Hugging Face's 47 maintained task tags and against measured GGUF supply per task, which
  corrected three entries (OCR is not a supply category; safety/verification is
  well-supplied; generative media is supply-rich but product-blocked). The *domain* axis
  remains less grounded than the slot axis, because no comparable maintained taxonomy of
  user intent exists.
- **The slot list will read as a roadmap and is not one.** Nothing here commits to
  building any slot, and several require plumbing that does not exist. Sequencing is
  deliberately absent.
- **"Distinct model class" is a judgement, not a measurement.** It has no threshold. It
  was applied by inspection of the GGUF ecosystem and will drift as that ecosystem does;
  a slot justified today may not be in a year.
- ~~**Safety/verification as a slot is the weakest entry.**~~ **Withdrawn.** This finding
  evaluated the domain against *Quorum's implementation* rather than against the domain.
  Quorum's layer is coded — envelope validation, sensitive-data matching — but
  "verification" as a domain also covers inferential work that is unambiguously
  model-shaped: checking a procedure against a regulatory corpus, claim verification,
  content classification. There are 274 GGUF `text-classification` models plus
  domain-compliance finetunes. The slot is sound; the finding measured the wrong referent.

### After drafting — legitimate-use lens

- **Four concepts is more than a small deployment needs.** Someone running one general
  model gains nothing from domain/slot/provider/attribute and pays for it in
  configuration surface. The design must degrade to "set one model and it works", or it
  will be worse than what it replaces for the majority case.
- **Eleven slots is a large configuration surface.** Every slot is a decision an operator
  did not previously have to make. *Partly addressed:* slots are now split into
  user-visible and infrastructural, which cuts the surface to roughly seven decisions with the remainder
  defaulted. Defaults and honest "not configured" states still matter more than the slots
  themselves, and the finding is reduced rather than closed.
- **Nothing here says how slots are discovered or advertised.** An operator cannot fill a
  slot they do not know exists, and the ADR is silent on the interface. Deliberate — it is
  a modelling decision, not a UI one — but it is the obvious next question and is not
  answered.

### Found after review, by the user

- **A domain named after a use concealed a missing slot.** *Vision* is a modality, *Speech*
  is a use within audio. Because the domain was not named for its modality, the question
  "where is audio's understanding model?" was never asked, and `audio-text-to-text` — a
  well-supplied class including Voxtral, Qwen2-Audio and Ultravox — had no slot while its
  exact structural counterpart in vision did. **Applied:** domain renamed to *Audio*, slot
  added, and the naming rule stated so the next domain does not repeat it.
- Note the failure mode. The slot list was checked against measured supply and the check
  *passed*, because it verified that every listed slot had models behind it. It could not
  detect a slot that was never listed. Supply data validates inclusions; it does not
  surface omissions.

### Inherent limitations

- This describes a target. Nothing in the current codebase implements slots, and the ADR
  does not schedule the work.
- The boundary between "distinct operation" and "disposition" is judgement. Creative
  versus code is clear; a domain-specialised medical or legal finetune is genuinely
  ambiguous under this test, and the ADR does not resolve it.
