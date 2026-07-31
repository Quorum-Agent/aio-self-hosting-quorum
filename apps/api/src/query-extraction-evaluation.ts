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
// Two examples do the heavy lifting. Instruction-only prompting made every
// model return the entire message: "if it is already a good query, return it
// whole" is the easiest branch to take, and small models take it every time.
const SPAN_SYSTEM = [
  "You extract the search query hidden inside a chat message.",
  "Return the SHORTEST span of the message that a search engine needs, copied character-for-character from the message.",
  "Never reword, reorder, fix spelling, or add words. The span must appear verbatim in the message.",
  "Remove greetings, pleasantries, thanks, requests for help, and framing about who is asking or why.",
  "Keep facts the question depends on.",
  "",
  'Message: "Hi there, my colleague and I disagree about the fastest sorting algorithm for nearly sorted data. Any thoughts?"',
  'span: "fastest sorting algorithm for nearly sorted data"',
  "",
  'Message: "Could you please tell me when the next total solar eclipse is? Thanks so much!"',
  'span: "when the next total solar eclipse is"',
].join("\n");

async function modelSpan(model: string, prompt: string): Promise<string> {
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: SPAN_SCHEMA,
      think: false,
      keep_alive: "5m",
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
  const parsed = JSON.parse(raw) as { span?: unknown };
  return typeof parsed.span === "string" ? parsed.span.trim() : "";
}

// A model that echoes the quoting style of the few-shot examples, or changes
// case, has not authored anything — it has reformatted. Realign such a span
// back onto the prompt's own bytes so the comparison measures extraction
// rather than punctuation habits, and so what would egress is still literally
// the prompt's text.
//
// Without this the harness scored qwen3.5:2b last of eight on 111 "violations"
// of which 101 were quotation marks the system prompt had taught it to add.
function realign(prompt: string, span: string): string | undefined {
  if (span === "") return undefined;
  if (prompt.includes(span)) return span;
  const unquoted = span.replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "").trim();
  if (unquoted && prompt.includes(unquoted)) return unquoted;
  const at = prompt.toLowerCase().indexOf(unquoted.toLowerCase());
  if (unquoted && at >= 0) return prompt.slice(at, at + unquoted.length);
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

function corpusCases(): ExtractionCase[] {
  const queries = JSON.parse(
    readFileSync(new URL("./query-extraction-corpus.json", import.meta.url), "utf8"),
  ) as string[];
  return queries.map((raw, index) => {
    const query = raw.replace(/\?+$/u, "");
    const prompt = WRAPPERS[index % WRAPPERS.length]!(query);
    return {
      name: `corpus ${index}`,
      prompt,
      ideal: query,
      noise: [],
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
    let totalF1 = 0;
    let noiseLeaks = 0;
    let notSubstring = 0;
    let errors = 0;
    let reformatted = 0;
    const started = performance.now();

    for (const testCase of cases) {
      let actual: string;
      try {
        actual = await strategy.extract(testCase.prompt);
      } catch (error) {
        errors += 1;
        console.log(
          `  ERROR ${strategy.name} :: ${testCase.name} :: ${(error as Error).message}`,
        );
        continue;
      }
      // The invariant, enforced rather than assumed. Reformatting is repaired
      // first; genuine authoring still fails.
      const aligned = realign(testCase.prompt, actual);
      if (aligned !== undefined && aligned !== actual) reformatted += 1;
      if (aligned !== undefined) actual = aligned;
      if (!testCase.prompt.includes(actual)) {
        notSubstring += 1;
        console.log(
          `  NOT-A-SUBSTRING ${strategy.name} :: ${testCase.name} :: ${actual}`,
        );
        continue;
      }
      const score = f1(actual, testCase.ideal);
      totalF1 += score;
      if (actual === testCase.ideal) exact += 1;
      const leaked = testCase.noise.filter((phrase) =>
        actual.toLowerCase().includes(phrase.toLowerCase()),
      );
      if (leaked.length > 0) noiseLeaks += 1;
      if (score < 1 && !useCorpus) {
        console.log(
          `  ${score.toFixed(2)} ${testCase.name}\n      got: ${actual}\n      want: ${testCase.ideal}`,
        );
      }
    }

    const elapsed = performance.now() - started;
    console.log(
      `SUMMARY ${strategy.name}: exact ${exact}/${cases.length}, ` +
        `mean F1 ${(totalF1 / cases.length).toFixed(3)}, ` +
        (useCorpus ? "" : `noise leaked in ${noiseLeaks}/${cases.length}, `) +
        `authored (rejected) ${notSubstring}, ` +
        `reformatted (repaired) ${reformatted}, ` +
        `errors ${errors}, ` +
        `${(elapsed / cases.length).toFixed(2)}ms per prompt\n`,
    );
  }
}

await main();
