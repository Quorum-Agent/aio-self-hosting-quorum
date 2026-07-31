/**
 * Measures how well a strategy turns a conversational prompt into a search
 * query.
 *
 * Quorum sends the user's prompt to the search provider verbatim, because
 * Q-07 and Q-21 established that model-authored text must never become an
 * outbound query — otherwise a classifier reading untrusted conversation
 * decides what leaves the device. The cost is that conversational framing
 * dominates the query: "My family and I were having a disagreement on the
 * best LLM model publicly available, trained for coding. Could you help us
 * out?" retrieved four generic LLM-background pages and nothing about coding
 * models, and the answering model fell back on training data.
 *
 * Any replacement has to satisfy the same invariant, so every strategy here
 * returns a span of the ORIGINAL prompt. That is checked, not trusted: a
 * strategy whose output is not a literal substring fails the case outright,
 * whatever its score would have been.
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

interface ExtractionCase {
  readonly name: string;
  readonly prompt: string;
  /** The span a good extractor should find. Must be a substring of prompt. */
  readonly ideal: string;
  /** Phrases that must NOT survive into the query. */
  readonly noise: readonly string[];
  /** True when the prompt is already the query, so the answer is to do nothing. */
  readonly bare?: boolean;
  /** Index into WRAPPERS, so scores can be reported per framing. */
  readonly wrapper?: number;
}

interface Strategy {
  readonly name: string;
  extract(prompt: string): string | Promise<string>;
}

const OLLAMA_URL = process.env["QUORUM_LOCAL_BASE_URL"]
  ? `${process.env["QUORUM_LOCAL_BASE_URL"].replace(/\/v1\/?$/u, "")}/api/chat`
  : "http://127.0.0.1:11434/api/chat";

const SPAN_SCHEMA = {
  type: "object",
  properties: { span: { type: "string" } },
  required: ["span"],
  additionalProperties: false,
} as const;

// The model selects; it never authors. Whatever comes back is checked against
// the prompt before it is allowed anywhere near a search provider, so a model
// that paraphrases fails the case rather than quietly changing what egresses.
//
// The examples are written as JSON objects because the response goes into a
// JSON string field where the quotes are already supplied. Writing them as
// `span: "..."` taught weaker models to emit the answer wrapped in literal
// quote characters: it cost qwen3.5:2b 99 of its 111 recorded "violations" and
// 0.37 mean F1. Two reviewers found that independently. Keep this shape.
//
// An earlier comment here claimed instruction-only prompting made every model
// return the whole message. That did not survive the corpus: zero-shot beats
// these examples for every model tested. The observation came from eleven
// hand-written cases and did not generalise. The examples are retained because
// they raise exact-match style compliance, not because they raise F1.
const SPAN_SYSTEM = [
  "You extract the search query hidden inside a chat message.",
  "Return the SHORTEST span of the message that a search engine needs, copied character-for-character from the message.",
  "Never reword, reorder, fix spelling, or add words. The span must appear verbatim in the message.",
  "Remove greetings, pleasantries, thanks, requests for help, and framing about who is asking or why.",
  "Keep facts the question depends on.",
  "",
  'Message: "Hi there, my colleague and I disagree about the fastest sorting algorithm for nearly sorted data. Any thoughts?"',
  '{"span": "fastest sorting algorithm for nearly sorted data"}',
  "",
  'Message: "Could you please tell me when the next total solar eclipse is? Thanks so much!"',
  '{"span": "when the next total solar eclipse is"}',
].join("\n");

// A model that returns unparseable JSON has failed at the task, which is not
// the same as the endpoint being unreachable. Throwing both as plain Errors
// put a model failure and an infrastructure failure in the same bucket, and
// the infrastructure bucket is excluded from scoring — so a model that emitted
// garbage was being let off rather than penalised.
class ModelOutputError extends Error {}

async function modelSpan(model: string, prompt: string): Promise<string> {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: SPAN_SCHEMA,
      // Correct for every model measured, and load-bearing for the leader:
      // qwen3:4b with thinking enabled spends its entire token budget in the
      // thinking channel and returns empty content on 60 of 60 cases. It costs
      // the Gemma models nothing — e2b is better without it, e4b unchanged but
      // five times slower.
      think: false,
      // Long enough that a model is not evicted between its own cases. At "5m"
      // a six-model sweep reloaded mid-run and the reload time landed in that
      // model's per-prompt average.
      keep_alive: "10m",
      options: { temperature: 0, num_predict: 300 },
      messages: [
        { role: "system", content: SPAN_SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) throw new Error(`${model}: HTTP ${response.status}`);
  const payload = (await response.json()) as { message?: { content?: string } };
  const raw = payload.message?.content ?? "";
  let parsed: { span?: unknown };
  try {
    parsed = JSON.parse(raw) as { span?: unknown };
  } catch {
    throw new ModelOutputError(`${model}: unparseable response ${JSON.stringify(raw.slice(0, 80))}`);
  }
  return typeof parsed.span === "string" ? parsed.span.trim() : "";
}

// A model that echoes the quoting style of the few-shot examples, changes
// case, or collapses whitespace has not authored anything — it has
// reformatted. Realign such a span back onto the prompt's own bytes so the
// comparison measures extraction rather than punctuation habits, and so what
// would egress is still literally the prompt's text.
//
// The invariant being protected is "the model did not author new content".
// Case and whitespace do not violate it. Fixing a typo, substituting a word,
// or completing a title does, and those still fail: this only ever returns a
// slice of the prompt, never the model's own bytes.
//
// Without this the harness scored qwen3.5:2b last of eight on 111 "violations"
// of which 101 were quotation marks the system prompt had taught it to add.
function realign(prompt: string, span: string): string | undefined {
  if (span === "") return undefined;
  if (prompt.includes(span)) return span;
  const trimmed = span.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/gu, "").trim();
  if (trimmed && prompt.includes(trimmed)) return trimmed;
  const at = prompt.toLowerCase().indexOf(trimmed.toLowerCase());
  if (trimmed && at >= 0) return prompt.slice(at, at + trimmed.length);
  // Whitespace-insensitive last resort: match on collapsed text, then map the
  // hit back to the prompt's own offsets so the returned span stays verbatim.
  if (trimmed) {
    const collapsed = trimmed.replace(/\s+/gu, " ").toLowerCase();
    const offsets: number[] = [];
    let flat = "";
    for (let index = 0; index < prompt.length; index += 1) {
      const character = prompt[index]!;
      if (/\s/u.test(character)) {
        if (flat.endsWith(" ")) continue;
        flat += " ";
      } else {
        flat += character.toLowerCase();
      }
      offsets.push(index);
    }
    const hit = flat.indexOf(collapsed);
    if (hit >= 0) {
      const start = offsets[hit]!;
      const end = offsets[Math.min(hit + collapsed.length - 1, offsets.length - 1)]!;
      return prompt.slice(start, end + 1);
    }
  }
  return undefined;
}

const CASES: readonly ExtractionCase[] = [
  {
    name: "family disagreement, trailing request",
    prompt:
      "My family and I were having a disagreement on the best LLM model publicly available, trained for coding. Could you help us out?",
    ideal: "best LLM model publicly available, trained for coding",
    noise: ["My family", "Could you help us out"],
  },
  {
    name: "family discussion, open weight",
    prompt:
      "My family and I are having a discussion about which is the best open weight coding model. Could you help out?",
    ideal: "best open weight coding model",
    noise: ["My family", "Could you help out"],
  },
  {
    name: "greeting prefix",
    prompt:
      "Hey, quick question — what is the most recent coding model advisor from Qwen?",
    ideal: "most recent coding model advisor from Qwen",
    noise: ["Hey", "quick question"],
  },
  {
    name: "hedged opener and thanks",
    prompt:
      "So I was wondering, could you tell me what the latest OpenSSL CVE is? Thanks!",
    ideal: "the latest OpenSSL CVE",
    noise: ["I was wondering", "Thanks"],
  },
  {
    name: "polite wrapper",
    prompt:
      "Please could you look up the current exchange rate for the Japanese yen. Thank you kindly.",
    ideal: "the current exchange rate for the Japanese yen",
    noise: ["Please could you", "Thank you kindly"],
  },
  {
    name: "already clean",
    prompt: "latest OpenSSL CVE advisory",
    ideal: "latest OpenSSL CVE advisory",
    noise: [],
  },
  {
    name: "no framing to strip",
    prompt: "What are the current EU AI Act enforcement deadlines?",
    ideal: "current EU AI Act enforcement deadlines",
    noise: [],
  },
  {
    name: "context before the question",
    prompt:
      "I am building a self-hosted app and my friend disagrees with me. What is the best open weight embedding model right now?",
    ideal: "best open weight embedding model right now",
    noise: ["my friend disagrees", "I am building"],
  },

  // The three below are the shapes that broke the first deterministic trim when
  // it met real prompts from the conversation history. They are written from
  // that structure rather than copied, so the failure is reproducible without
  // putting anyone's conversations in the repository. Each one punishes a
  // different wrong assumption, and a strategy that scores well on the cases
  // above while failing these has learned the test rather than the task.

  {
    // Broke "prefer the last sentence": here the earlier sentence carries the
    // constraint the question is meaningless without. The trim returned only
    // "How many units can it finish in 30 minutes".
    name: "premise carries the constraint",
    prompt:
      "A local service handles 120 units in 8 minutes at a constant rate. How many units can it finish in 30 minutes?",
    ideal:
      "A local service handles 120 units in 8 minutes at a constant rate. How many units can it finish in 30 minutes",
    noise: [],
  },
  {
    // Broke the lead-in pattern: "Hello" was consumed and "there," stranded,
    // producing "there, what are your current limits".
    name: "greeting fused to the question",
    prompt: "Hello there, what are your current rate limits",
    ideal: "current rate limits",
    noise: ["Hello", "there,"],
  },
  {
    // The worst observed failure: the framing clause matched greedily across
    // the substance and the whole prompt collapsed to a single word.
    name: "enumeration is the substance",
    prompt:
      "I am thinking about building an application but I don't know if I should use SQL, Oracle, MongoDB, or Dataverse",
    ideal: "SQL, Oracle, MongoDB, or Dataverse",
    noise: ["I am thinking about"],
  },
];

// Conversational scaffolding that carries no retrieval value. Deterministic on
// purpose: this list is code, so nothing a model emits can extend it.
const LEAD_IN =
  /^(?:\s*(?:hey|hi|hello|so|ok(?:ay)?|well|right)\b[\s,—-]*)*(?:\s*(?:please\s+)?(?:quick question|i(?:'m| am)?\s+wondering|i was wondering|could you|can you|would you|will you|tell me|let me know|help me|i'd like to know|i want to know|do you know|any idea)\b[\s,—-]*)*(?:\s*(?:what|which|who|where|when)\s+(?:is|are|was|were)\s+)?/iu;

const TAIL =
  /[\s,—-]*(?:thanks?(?:\s+(?:a lot|so much|kindly|in advance))?|thank you(?:\s+kindly)?|cheers|please|could you help(?:\s+(?:us|me))?\s*out|help(?:\s+(?:us|me))?\s*out|any ideas?|any thoughts?)\s*[.!?]*\s*$/iu;

const FRAMING_CLAUSE =
  /^.*?\b(?:disagreement on|discussion about(?: which is)?|argument about|debate about|disagrees with me[.!?]?)\s*/iu;

function trimFraming(prompt: string): string {
  let text = prompt.trim();
  // Prefer the last sentence when an earlier one is pure context-setting.
  const sentences = text
    .split(/(?<=[.?!])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (sentences.length > 1) {
    const substantive = sentences.filter(
      (sentence) => !TAIL.test(sentence) || sentence.replace(TAIL, "").trim(),
    );
    const withoutPleasantries = substantive.filter(
      (sentence) => sentence.replace(TAIL, "").trim().split(/\s+/u).length > 3,
    );
    if (withoutPleasantries.length > 0) {
      text = withoutPleasantries.at(-1)!;
    }
  }
  text = text.replace(TAIL, "");
  text = text.replace(FRAMING_CLAUSE, "");
  text = text.replace(LEAD_IN, "");
  return text.replace(/^[\s,—-]+|[\s,—-]+$/gu, "").replace(/[.?!]+$/u, "");
}

// A larger set built from real search queries — MS MARCO and Natural Questions,
// i.e. things people actually typed into a search engine — wrapped in
// conversational scaffolding. The gold span is the original query, so it is a
// substring by construction and no hand-labelling is involved.
//
// The queries are real; the wrappers are not. This removes the bias in WHAT is
// being asked, which was the larger problem with eleven hand-written cases, but
// it does not remove the bias in HOW it is framed. Read it as a broad ordering
// signal and keep the curated cases for the specific shapes known to break.
const WRAPPERS: ReadonlyArray<(query: string) => string> = [
  (q) => `Hey, quick question — ${q}?`,
  (q) => `My friend and I were arguing about this. ${q}? Could you help us out?`,
  (q) => `So I was wondering, could you tell me ${q}? Thanks!`,
  (q) => `Please could you look up ${q}. Thank you kindly.`,
  (q) => `${q}? Any thoughts?`,
  (q) => `Hi there, ${q}`,
  (q) => `I am working on something and got stuck. ${q}?`,
  (q) => `Can you tell me ${q}? Cheers.`,
  (q) => `${q}`,
];

// The last wrapper is the identity. Those cases are no-ops where the correct
// answer is to return the message unchanged, and they are scored separately
// because they measure a different skill from trimming — and because they
// decide the outcome. On the first corpus run the 26 no-op cases carried half
// the gap between the top two models: the leader scores a perfect 1.000 on
// them, which is precisely the behaviour the eleven curated cases had been
// iterated against. Reporting one blended number let a sub-task the harness
// author had tuned for silently pick the winner.
const BARE_WRAPPER_INDEX = WRAPPERS.length - 1;

function corpusCases(): ExtractionCase[] {
  const queries = JSON.parse(
    readFileSync(new URL("./query-extraction-corpus.json", import.meta.url), "utf8"),
  ) as string[];
  return queries.map((raw, index) => {
    // Strip any trailing terminator, not just "?". Stripping only question
    // marks left queries ending in "." to be wrapped into prompts like
    // "chart for foods low in potassium.? Could you help us out?", where the
    // gold span is unreachable because the prompt is malformed. The model was
    // then scored down for the harness's own punctuation bug.
    //
    // Typos in the source queries are deliberately NOT repaired. A model that
    // "fixes" one has authored words the user did not write, which is the
    // exact failure this harness exists to catch, so those cases must keep
    // failing for the models that rewrite them.
    const query = raw.replace(/[?.!]+$/u, "").trim();
    // Modular assignment is deliberate and is already the right thing. The
    // corpus IS positionally structured — the rate of wh-questions runs
    // 0.38 / 0.80 / 0.70 across its three thirds — so the obvious worry is
    // that wrapper becomes a proxy for query type. It does not: `index % 9`
    // gives wrapper w the indices w, w+9, w+18 …, an evenly spaced sample of
    // the whole corpus, which is a stratified draw rather than a biased one.
    //
    // Measured rather than assumed. Per-wrapper wh-rate spreads 0.52–0.70
    // under this scheme, and identically under a coprime-multiplier shuffle.
    // The shuffle was written, measured, and reverted: it changes which
    // residue class each wrapper draws and nothing else.
    const wrapper = index % WRAPPERS.length;
    return {
      name: `corpus ${index}`,
      prompt: WRAPPERS[wrapper]!(query),
      ideal: query,
      noise: [],
      wrapper,
      bare: wrapper === BARE_WRAPPER_INDEX,
    } satisfies ExtractionCase;
  });
}

const MODELS = (
  process.env["QUORUM_EXTRACTION_MODELS"] ??
  "qwen3.5:2b,qwen3:4b,phi4-mini:latest,gemma4:e2b,gemma4:e4b,qwen3.5:9b"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const STRATEGIES: readonly Strategy[] = [
  { name: "verbatim (today)", extract: (prompt) => prompt },
  { name: "deterministic trim", extract: trimFraming },
  ...MODELS.map((model) => ({
    name: `model ${model}`,
    extract: (prompt: string) => modelSpan(model, prompt),
  })),
];

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
}

function f1(actual: string, ideal: string): number {
  const a = tokens(actual);
  const b = tokens(ideal);
  if (a.length === 0 || b.length === 0) return 0;
  const remaining = [...b];
  let overlap = 0;
  for (const token of a) {
    const at = remaining.indexOf(token);
    if (at >= 0) {
      overlap += 1;
      remaining.splice(at, 1);
    }
  }
  if (overlap === 0) return 0;
  const precision = overlap / a.length;
  const recall = overlap / b.length;
  return (2 * precision * recall) / (precision + recall);
}

async function main(): Promise<void> {
  const useCorpus = process.env["QUORUM_EXTRACTION_CORPUS"] === "1";
  const cases: readonly ExtractionCase[] = useCorpus ? corpusCases() : CASES;
  console.log(
    `${cases.length} cases (${useCorpus ? "generated from real search queries" : "curated failure shapes"})
`,
  );
  for (const testCase of cases) {
    if (!testCase.prompt.includes(testCase.ideal)) {
      console.error(
        `BROKEN CASE "${testCase.name}": ideal is not a substring of prompt.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  for (const strategy of STRATEGIES) {
    let exact = 0;
    let noiseLeaks = 0;
    let notSubstring = 0;
    let errors = 0;
    let reformatted = 0;
    // Scores are kept per case rather than summed, so the bare and wrapped
    // subsets can be reported separately and so a paired comparison against
    // another strategy is possible at all.
    const scores: number[] = [];
    const bareScores: number[] = [];
    const wrappedScores: number[] = [];
    const latencies: number[] = [];
    // Per-framing scores. Publishing the profile is strictly more informative
    // than any single blended number, and it dissolves rather than answers the
    // question of what fraction of real prompts are already clean: a reader
    // with their own prior can weight these themselves. It is also what made
    // the no-op cluster visible in the first place.
    const perWrapper = new Map<number, number[]>();
    const record = (testCase: ExtractionCase, score: number): void => {
      scores.push(score);
      (testCase.bare ? bareScores : wrappedScores).push(score);
      if (testCase.wrapper !== undefined) {
        const bucket = perWrapper.get(testCase.wrapper) ?? [];
        bucket.push(score);
        perWrapper.set(testCase.wrapper, bucket);
      }
    };

    for (const testCase of cases) {
      let actual: string;
      const callStarted = performance.now();
      try {
        actual = await strategy.extract(testCase.prompt);
      } catch (error) {
        // A model that returned garbage failed the case and scores zero. Only
        // an infrastructure failure — endpoint unreachable, HTTP error — is
        // excluded, because scoring it would silently depress whichever model
        // happened to run during a bad window rather than measuring the model.
        if (error instanceof ModelOutputError) {
          notSubstring += 1;
          record(testCase, 0);
          console.log(`  BAD-OUTPUT ${strategy.name} :: ${testCase.name} :: ${error.message}`);
        } else {
          errors += 1;
          console.log(
            `  ERROR ${strategy.name} :: ${testCase.name} :: ${(error as Error).message}`,
          );
        }
        continue;
      }
      latencies.push(performance.now() - callStarted);
      // The invariant, enforced rather than assumed. Reformatting is repaired
      // first; genuine authoring still fails.
      const aligned = realign(testCase.prompt, actual);
      if (aligned !== undefined && aligned !== actual) reformatted += 1;
      if (aligned !== undefined) actual = aligned;
      const leaked = testCase.noise.filter((phrase) =>
        actual.toLowerCase().includes(phrase.toLowerCase()),
      );
      if (leaked.length > 0) noiseLeaks += 1;
      if (!testCase.prompt.includes(actual)) {
        notSubstring += 1;
        record(testCase, 0);
        console.log(
          `  NOT-A-SUBSTRING ${strategy.name} :: ${testCase.name} :: ${actual}`,
        );
        continue;
      }
      const score = f1(actual, testCase.ideal);
      record(testCase, score);
      if (actual === testCase.ideal) exact += 1;
      if (score < 1 && !useCorpus) {
        console.log(
          `  ${score.toFixed(2)} ${testCase.name}\n      got: ${actual}\n      want: ${testCase.ideal}`,
        );
      }
    }

    // The first call pays the model load, which on a cold 9.6GB model is over
    // twenty seconds. Folding that into a per-prompt mean gave whichever model
    // Ollama happened to have resident an advantage of roughly 12% — an
    // artifact of run order, not a property of the model. Median of the
    // remaining calls is the number that survives being run in a different
    // order.
    const warm = latencies.slice(1).sort((left, right) => left - right);
    const median = warm.length > 0 ? warm[Math.floor(warm.length / 2)]! : 0;
    console.log(
      `SUMMARY ${strategy.name}: exact ${exact}/${scores.length}, ` +
        `mean F1 ${mean(scores).toFixed(3)}` +
        (bareScores.length > 0 && wrappedScores.length > 0
          ? ` (wrapped ${mean(wrappedScores).toFixed(3)} on ${wrappedScores.length}, ` +
            `already-clean ${mean(bareScores).toFixed(3)} on ${bareScores.length})`
          : "") +
        `, ` +
        (useCorpus ? "" : `noise leaked in ${noiseLeaks}/${scores.length}, `) +
        `authored (rejected) ${notSubstring}, ` +
        `reformatted (repaired) ${reformatted}, ` +
        `excluded (infrastructure) ${errors}, ` +
        `${median.toFixed(0)}ms warm median, ` +
        `${(latencies[0] ?? 0).toFixed(0)}ms first call`,
    );
    if (perWrapper.size > 0) {
      const profile = [...perWrapper.entries()]
        .sort(([left], [right]) => left - right)
        .map(([wrapper, values]) => {
          const label = wrapper === BARE_WRAPPER_INDEX ? "bare" : `w${wrapper}`;
          return `${label} ${mean(values).toFixed(3)}`;
        })
        .join("  ");
      console.log(`  by framing: ${profile}`);
    }
    console.log("");
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

await main();
