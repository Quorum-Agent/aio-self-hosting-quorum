#!/usr/bin/env node
/**
 * Measure what the documentation actually teaches a fresh reader.
 *
 * This is not a review tool. Asking a model to "review these docs" returns
 * opinions about prose. This gives models *only* the documentation, asks
 * questions whose correct answers are known, and scores what they conclude.
 * A wrong answer is a defect in the document, not a matter of taste.
 *
 * It exists because a reader — human or assistant — repeatedly derived false
 * conclusions from these files, and no amount of re-reading them caught it.
 * The first run found a live defect that three reviewers and the author had
 * all missed: two frontier models from different labs answered that a loopback
 * SearXNG keeps your query on your machine, both quoting the README correctly.
 * The sentence they quoted was true; it was also the only thing the docs said
 * about that provider's data flow, so the wrong inference was the only one on
 * offer.
 *
 * Treat a failure the way this repo treats a failing test: the document is
 * wrong until the probe passes. And re-run after fixing, because "I clarified
 * it" and "a reader now gets it right" are different claims — the same
 * distinction rule 1 in CLAUDE.md draws for code.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node scripts/doc-probe.mjs
 *   OPENROUTER_API_KEY=... node scripts/doc-probe.mjs --only searxng
 *
 * Costs real money — **$0.45 measured** for a full run of 6 questions across 6
 * models on 2026-07-31, and it sends the documentation to third-party
 * inference providers. Both are reasons it is a script you run deliberately
 * rather than part of any suite. Use `--only <key>` while iterating on one
 * document; a single question across all models is about a tenth of that.
 *
 * (Each question is a separate request per model rather than one batched call.
 * That costs more — the documents are re-sent every time — and is deliberate:
 * batched questions let a model's answer to one contaminate the next, which
 * would make a pass mean less than it appears to.)
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Documents under test. A reader gets these and nothing else — no source. */
const DOCUMENTS = [
  "docs/architecture.md",
  "README.md",
  "docs/decisions/README.md",
];

/**
 * Each question has a known correct answer and a predicate that recognises it.
 *
 * Keep `expect` loose enough to accept any correct phrasing and strict enough
 * to reject the specific wrong answer. A predicate that passes on both is the
 * documentation equivalent of a fixture that cannot reach the wrong answer.
 */
const QUESTIONS = [
  {
    key: "offline",
    ask: "Does 'Offline' mode mean the application makes no network connections at all? Begin with YES or NO.",
    truth: "NO — it constrains where computation happens, not whether a socket opens.",
    expect: (a) => /^\W*no\b/i.test(a),
  },
  {
    key: "purpose",
    ask: "In one or two sentences: what is this project FOR? What problem does a user adopt it to solve?",
    truth:
      "Compose specialist models you choose on hardware you control, replacing one large generalist at lower memory. Capability ownership, not data privacy.",
    // Must name the composition goal. Naming only privacy is the failure.
    expect: (a) =>
      /(specialist|smaller model|multiple model)/i.test(a) &&
      /(less memory|lower memory|less vram|memory|generalist)/i.test(a),
  },
  {
    key: "balanced",
    ask: "Under the 'Balanced' policy, can the text of my conversation leave my machine? Begin with YES or NO.",
    truth: "YES — balanced has an inference ceiling of cloud; preferLocal only sorts.",
    expect: (a) => /^\W*yes\b/i.test(a),
  },
  {
    key: "sensitive",
    ask: "A request is detected as containing sensitive data. Exactly which execution locations may answer it?",
    truth: "Only device/local. Not a LAN peer, not rented hardware, not cloud.",
    // Naming cloud alone is the historical error: it lets a LAN peer through.
    expect: (a) =>
      /\blocal\b/i.test(a) && /(network|lan|peer)/i.test(a) && /(exclud|not|never|only)/i.test(a),
  },
  {
    key: "searxng",
    ask: "If I run SearXNG on loopback (127.0.0.1) and select it as my search provider, does my search query stay on my machine? Begin with YES or NO.",
    truth: "NO — SearXNG is a metasearch proxy and forwards every query upstream.",
    expect: (a) => /^\W*no\b/i.test(a),
  },
  {
    key: "adr",
    ask: "I want to build something an accepted ADR in this repo recommends against. Does that ADR forbid it? What authority does an ADR have over current work?",
    truth:
      "No. An ADR records why a past decision was made; architecture.md is current state. Superseding one is normal.",
    expect: (a) => /(does not forbid|not binding|no\b|record|histor|supersed)/i.test(a),
  },
];

/** Diverse families, all strong enough that a wrong answer implicates the doc. */
const MODELS = [
  "google/gemini-3.1-pro-preview",
  "deepseek/deepseek-r1",
  "qwen/qwen3.7-max",
  "x-ai/grok-4.5",
  "moonshotai/kimi-k2-thinking",
  "mistralai/mistral-large-2512",
];

const COST_CAP_USD = 1.0;

const SYSTEM =
  "You are reading the complete documentation for a software project. Answer ONLY from these documents. " +
  "Do not use outside knowledge about similar projects, and do not guess. If the documents do not answer a " +
  "question, say NOT STATED. Be concise: at most three sentences per answer.";

async function main() {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set. This probe calls a paid API.");
    process.exit(2);
  }

  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex > -1 ? process.argv[onlyIndex + 1] : null;
  const questions = only ? QUESTIONS.filter((q) => q.key === only) : QUESTIONS;
  if (questions.length === 0) {
    console.error(`No question named "${only}". Known: ${QUESTIONS.map((q) => q.key).join(", ")}`);
    process.exit(2);
  }

  let docs = "";
  for (const path of DOCUMENTS) {
    docs += `===== ${path} =====\n${await readFile(resolve(ROOT, path), "utf8")}\n\n`;
  }
  console.log(`${DOCUMENTS.length} documents, ~${Math.round(docs.length / 4000)}k tokens\n`);

  const results = new Map(questions.map((q) => [q.key, []]));
  let spent = 0;

  for (const model of MODELS) {
    if (spent >= COST_CAP_USD) {
      console.log(`\nSTOPPED at $${spent.toFixed(3)} (cap $${COST_CAP_USD})`);
      break;
    }
    for (const question of questions) {
      let answer = "";
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            temperature: 0,
            usage: { include: true },
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: `${docs}QUESTION: ${question.ask}` },
            ],
          }),
        });
        const body = await res.json();
        if (body.error) {
          results.get(question.key).push({ model, status: "ERROR", answer: body.error.message });
          continue;
        }
        spent += Number(body.usage?.cost ?? 0);
        answer = (body.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
      } catch (error) {
        results.get(question.key).push({ model, status: "ERROR", answer: String(error.message) });
        continue;
      }
      results.get(question.key).push({
        model,
        status: question.expect(answer) ? "PASS" : "FAIL",
        answer,
      });
    }
  }

  let failed = 0;
  for (const question of questions) {
    const rows = results.get(question.key);
    const passes = rows.filter((r) => r.status === "PASS").length;
    const answered = rows.filter((r) => r.status !== "ERROR").length;
    const bad = rows.filter((r) => r.status === "FAIL");
    failed += bad.length;
    console.log(`[${question.key}] ${passes}/${answered} correct`);
    console.log(`   truth: ${question.truth}`);
    for (const row of bad) {
      console.log(`   FAIL ${row.model}`);
      console.log(`        "${row.answer.slice(0, 220)}"`);
    }
    console.log("");
  }

  console.log(`cost $${spent.toFixed(4)}`);
  if (failed > 0) {
    console.log(`\n${failed} wrong answers. The documentation is what needs changing, not the reader.`);
    console.log("After editing, re-run: a clearer sentence and a reader who gets it right are different claims.");
    process.exit(1);
  }
  console.log("\nEvery model answered correctly.");
}

await main();
