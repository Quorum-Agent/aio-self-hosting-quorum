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
  extract(prompt: string): string;
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

const STRATEGIES: readonly Strategy[] = [
  { name: "verbatim (today)", extract: (prompt) => prompt },
  { name: "deterministic trim", extract: trimFraming },
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

function main(): void {
  for (const testCase of CASES) {
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
    const started = performance.now();

    for (const testCase of CASES) {
      const actual = strategy.extract(testCase.prompt);
      // The invariant, enforced rather than assumed.
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
      if (score < 1) {
        console.log(
          `  ${score.toFixed(2)} ${testCase.name}\n      got: ${actual}\n      want: ${testCase.ideal}`,
        );
      }
    }

    const elapsed = performance.now() - started;
    console.log(
      `SUMMARY ${strategy.name}: exact ${exact}/${CASES.length}, ` +
        `mean F1 ${(totalF1 / CASES.length).toFixed(3)}, ` +
        `noise leaked in ${noiseLeaks}/${CASES.length}, ` +
        `substring violations ${notSubstring}, ` +
        `${(elapsed / CASES.length).toFixed(2)}ms per prompt\n`,
    );
  }
}

main();
