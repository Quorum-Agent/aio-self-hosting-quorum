import { resolve } from "node:path";

import { RequestCompiler } from "@quorum/core";
import type { ChatMessage, RequestIntent } from "@quorum/core";
import { config as loadEnvironment } from "dotenv";

import { loadConfig, PROJECT_ROOT } from "./config.js";
import { InferenceScheduler } from "./inference-scheduler.js";
import { LocalPromptAnalyzer } from "./prompt-analyzer.js";

interface EvaluationCase {
  name: string;
  expected: RequestIntent;
  messages: ChatMessage[];
}

interface EvaluationResult {
  name: string;
  expected: RequestIntent;
  actual: RequestIntent | "error";
  effective: RequestIntent | "error";
  confidence: number;
  elapsedMs: number;
  rawPassed: boolean;
  effectivePassed: boolean;
}

loadEnvironment({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

function messages(...entries: Array<[ChatMessage["role"], string]>): ChatMessage[] {
  return entries.map(([role, content], index) => ({
    id: `message-${index}`,
    role,
    content,
    createdAt: new Date(index).toISOString(),
  }));
}

const EVALUATION_CASES: EvaluationCase[] = [
  {
    name: "jQuery follow-up",
    expected: "coding",
    messages: messages(
      ["user", "Create a dynamic SQL PIVOT query for Oracle."],
      ["assistant", "Here is an Oracle implementation."],
      ["user", "Would JQuery be any different?"],
    ),
  },
  {
    name: "JavaScript alias follow-up",
    expected: "coding",
    messages: messages(
      ["user", "Create an Oracle PIVOT query."],
      ["assistant", "Here is the query."],
      ["user", "Thank you. Could this be used easily with JS applications?"],
    ),
  },
  {
    name: "Python replacement follow-up",
    expected: "coding",
    messages: messages(
      ["user", "Create an Oracle PIVOT query."],
      ["assistant", "Here is the query."],
      ["user", "What about Python instead?"],
    ),
  },
  {
    name: "React behavior follow-up",
    expected: "coding",
    messages: messages(
      ["user", "Create this component in Vue."],
      ["assistant", "Here is the Vue component."],
      ["user", "Does React work the same way?"],
    ),
  },
  {
    name: "TypeScript",
    expected: "coding",
    messages: messages(["user", "Refactor this TypeScript function."]),
  },
  {
    name: "Python",
    expected: "coding",
    messages: messages(["user", "Does this work in Python?"]),
  },
  {
    name: "Java",
    expected: "coding",
    messages: messages(["user", "Write a Java service for this endpoint."]),
  },
  {
    name: "C sharp",
    expected: "coding",
    messages: messages(["user", "Debug this C# class."]),
  },
  {
    name: "C plus plus",
    expected: "coding",
    messages: messages(["user", "Optimize this C++ loop."]),
  },
  {
    name: "Go",
    expected: "coding",
    messages: messages(["user", "Create a Go HTTP server."]),
  },
  {
    name: "Rust",
    expected: "coding",
    messages: messages(["user", "Implement the parser in Rust."]),
  },
  {
    name: "React",
    expected: "coding",
    messages: messages(["user", "How should I structure React state?"]),
  },
  {
    name: "Angular and Vue",
    expected: "coding",
    messages: messages(["user", "Migrate this Angular component to Vue.js."]),
  },
  {
    name: "PostgreSQL",
    expected: "coding",
    messages: messages(["user", "Change the PostgreSQL query."]),
  },
  {
    name: "npm",
    expected: "coding",
    messages: messages(["user", "Install this dependency with npm."]),
  },
  {
    name: "pytest",
    expected: "coding",
    messages: messages(["user", "Run this test with pytest."]),
  },
  {
    name: "Docker",
    expected: "coding",
    messages: messages(["user", "Containerize this service with Docker."]),
  },
  {
    name: "Kubernetes",
    expected: "coding",
    messages: messages(["user", "Deploy this service with Kubernetes."]),
  },
  {
    name: "Android Activity",
    expected: "coding",
    messages: messages(["user", "Why does my Android Activity crash?"]),
  },
  {
    name: "HTTP error",
    expected: "coding",
    messages: messages(["user", "Explain this HTTP 500 from the API."]),
  },
  {
    name: "Helm",
    expected: "coding",
    messages: messages(["user", "Update this Helm chart."]),
  },
  {
    name: "CUDA",
    expected: "coding",
    messages: messages(["user", "Optimize this CUDA kernel."]),
  },
  {
    name: "YAML",
    expected: "coding",
    messages: messages(["user", "Validate this YAML config."]),
  },
  {
    name: "regular expression",
    expected: "coding",
    messages: messages(["user", "Fix this regular expression."]),
  },
  {
    name: "AWS Lambda",
    expected: "coding",
    messages: messages(["user", "Deploy the AWS Lambda."]),
  },
  {
    name: "JS Bach",
    expected: "conversation",
    messages: messages(["user", "Tell me about JS Bach."]),
  },
  {
    name: "TS Eliot",
    expected: "conversation",
    messages: messages(["user", "Read a TS Eliot poem."]),
  },
  {
    name: "react verb",
    expected: "conversation",
    messages: messages(["user", "How should I react to criticism?"]),
  },
  {
    name: "rust noun",
    expected: "conversation",
    messages: messages(["user", "There is rust on my bicycle."]),
  },
  {
    name: "go verb",
    expected: "conversation",
    messages: messages(["user", "Should I go to the store?"]),
  },
  {
    name: "oracle noun",
    expected: "conversation",
    messages: messages(["user", "What was the oracle at Delphi?"]),
  },
  {
    name: "angular momentum",
    expected: "conversation",
    messages: messages(["user", "Explain angular momentum."]),
  },
  {
    name: "python animal",
    expected: "conversation",
    messages: messages(["user", "What does a python eat?"]),
  },
  {
    name: "Java coffee",
    expected: "conversation",
    messages: messages(["user", "Tell me about Java coffee."]),
  },
  {
    name: "nix verb",
    expected: "conversation",
    messages: messages(["user", "Please nix that proposal."]),
  },
  {
    name: "groovy adjective",
    expected: "conversation",
    messages: messages(["user", "That song is groovy."]),
  },
  {
    name: "dart noun",
    expected: "conversation",
    messages: messages(["user", "Throw a dart at the board."]),
  },
  {
    name: "solidity noun",
    expected: "conversation",
    messages: messages(["user", "The solidity of packed snow varies."]),
  },
  {
    name: "flask noun",
    expected: "conversation",
    messages: messages(["user", "She took a flask with her."]),
  },
  {
    name: "Cassandra mythology",
    expected: "conversation",
    messages: messages(["user", "Tell me about Cassandra in Greek mythology."]),
  },
  {
    name: "prettier adjective",
    expected: "conversation",
    messages: messages(["user", "I need a prettier room."]),
  },
  {
    name: "go cross-cue",
    expected: "conversation",
    messages: messages(["user", "Should I use the bus or go by train?"]),
  },
  {
    name: "rust cross-cue",
    expected: "conversation",
    messages: messages([
      "user",
      "There is rust on my bike with a broken chain.",
    ]),
  },
  {
    name: "nest cross-cue",
    expected: "conversation",
    messages: messages(["user", "Build a nest for the birds."]),
  },
  {
    name: "spring cross-cue",
    expected: "conversation",
    messages: messages(["user", "How do I install a spring on a door?"]),
  },
  {
    name: "direct spring action",
    expected: "conversation",
    messages: messages(["user", "Install the spring on the door."]),
  },
  {
    name: "flask action",
    expected: "conversation",
    messages: messages(["user", "Use the flask for water."]),
  },
  {
    name: "dart action",
    expected: "conversation",
    messages: messages(["user", "Run the dart tournament."]),
  },
  {
    name: "flutter medical",
    expected: "conversation",
    messages: messages([
      "user",
      "Flutter activity in my chest worries me.",
    ]),
  },
  {
    name: "spring preposition",
    expected: "conversation",
    messages: messages(["user", "We run in the spring."]),
  },
  {
    name: "unity ordinary noun",
    expected: "conversation",
    messages: messages(["user", "They work in unity."]),
  },
  {
    name: "rails transport",
    expected: "conversation",
    messages: messages(["user", "Travel via rails to the station."]),
  },
  {
    name: "Java recipe",
    expected: "conversation",
    messages: messages(["user", "Use Java coffee in the recipe."]),
  },
  {
    name: "git ordinary noun",
    expected: "conversation",
    messages: messages(["user", "That miserable git stole my lunch."]),
  },
  {
    name: "terraform verb",
    expected: "conversation",
    messages: messages(["user", "Could humans terraform Mars?"]),
  },
  {
    name: "HCl chemistry",
    expected: "conversation",
    messages: messages(["user", "What is the molarity of HCl?"]),
  },
  {
    name: "Vue cinema",
    expected: "conversation",
    messages: messages(["user", "I booked tickets at Vue cinema."]),
  },
  {
    name: "sass verb",
    expected: "conversation",
    messages: messages(["user", "Do not sass me."]),
  },
  {
    name: "ruby gemstone",
    expected: "conversation",
    messages: messages(["user", "The museum displayed a ruby gem."]),
  },
  {
    name: "community unity project",
    expected: "conversation",
    messages: messages([
      "user",
      "Our community unity project brought neighbors together.",
    ]),
  },
  {
    name: "spring bean crop",
    expected: "conversation",
    messages: messages(["user", "The spring bean crop was planted early."]),
  },
  {
    name: "Java history class",
    expected: "conversation",
    messages: messages([
      "user",
      "I booked a Java class about Indonesian history.",
    ]),
  },
  {
    name: "oracle priestess query",
    expected: "conversation",
    messages: messages([
      "user",
      "The oracle query was answered by the priestess.",
    ]),
  },
  {
    name: "cargo transport",
    expected: "conversation",
    messages: messages([
      "user",
      "Tell me how to use cargo rail services.",
    ]),
  },
  {
    name: "rust metal test",
    expected: "conversation",
    messages: messages([
      "user",
      "The rust test on this metal was written yesterday.",
    ]),
  },
  {
    name: "Java geography follow-up",
    expected: "conversation",
    messages: messages(
      ["user", "Tell me about Indonesian islands."],
      ["assistant", "Indonesia has thousands of islands."],
      ["user", "What about Java?"],
    ),
  },
  {
    name: "C cross-cue",
    expected: "conversation",
    messages: messages(["user", "What is better, plan A or C?"]),
  },
  {
    name: "react cross-cue",
    expected: "conversation",
    messages: messages([
      "user",
      "Review the fashion models and react to their poses.",
    ]),
  },
  {
    name: "reasoning",
    expected: "reasoning",
    messages: messages(["user", "Solve 2x + 4 = 12 and explain the logic."]),
  },
  {
    name: "reasoning probability",
    expected: "reasoning",
    messages: messages([
      "user",
      "Calculate the probability of rolling two sixes.",
    ]),
  },
  {
    name: "reasoning proof",
    expected: "reasoning",
    messages: messages(["user", "Prove that the square root of 2 is irrational."]),
  },
  {
    name: "reasoning architecture tradeoff",
    expected: "reasoning",
    messages: messages([
      "user",
      "Compare a modular architecture with a monolith for a local-first assistant, then recommend a practical starting point.",
    ]),
  },
  {
    name: "document",
    expected: "document",
    messages: messages(["user", "Summarize the attached contract."]),
  },
  {
    name: "document invoice",
    expected: "document",
    messages: messages(["user", "Extract the dates from this invoice."]),
  },
  {
    name: "document spreadsheet",
    expected: "document",
    messages: messages(["user", "Review the attached spreadsheet."]),
  },
  {
    name: "vision",
    expected: "vision",
    messages: messages(["user", "What is visible in this screenshot?"]),
  },
  {
    name: "vision photo",
    expected: "vision",
    messages: messages(["user", "Identify the components in this PCB photo."]),
  },
  {
    name: "vision diagram",
    expected: "vision",
    messages: messages(["user", "Explain the connections in this diagram."]),
  },
  {
    name: "research",
    expected: "research",
    messages: messages(["user", "Research the latest Node.js release."]),
  },
  {
    name: "research current law",
    expected: "research",
    messages: messages([
      "user",
      "Find current federal tax law and cite the sources.",
    ]),
  },
  {
    name: "research current release",
    expected: "research",
    messages: messages([
      "user",
      "Search the web for the most recent PostgreSQL release.",
    ]),
  },
  {
    name: "ordinary conversation",
    expected: "conversation",
    messages: messages(["user", "Tell me a short joke."]),
  },
];

async function main(): Promise<void> {
  const model = process.argv[2] ?? "qwen3.5:2b";
  const config = loadConfig();
  const analyzer = new LocalPromptAnalyzer({
    id: `local:classifier:${model}`,
    label: model,
    baseUrl: config.local.baseUrl,
    apiKey: config.local.apiKey,
    model,
    contextWindow: config.local.promptAnalyzer.contextWindow,
    scheduler: new InferenceScheduler(),
  });
  const compiler = new RequestCompiler();
  const results: EvaluationResult[] = [];

  console.log(`Evaluating ${model} across ${EVALUATION_CASES.length} cases...`);
  console.log(
    "Model scores are baseline-conditioned because this exercises the production request path.",
  );
  for (const testCase of EVALUATION_CASES) {
    const startedAt = performance.now();
    try {
      const baseline = compiler.compile({
        conversationId: `evaluation-${testCase.name}`,
        policy: "balanced",
        messages: testCase.messages,
      });
      const analysis = await analyzer.analyze({
        messages: testCase.messages,
        baseline: baseline.analysis,
        baselineIntentSource: baseline.requirements.intentSource,
      });
      const effective = compiler.applyPromptAnalysis(
        baseline,
        analyzer,
        analysis,
      ).requirements.intent;
      const result: EvaluationResult = {
        name: testCase.name,
        expected: testCase.expected,
        actual: analysis.intent,
        effective,
        confidence: analysis.confidence,
        elapsedMs: Math.round(performance.now() - startedAt),
        rawPassed: analysis.intent === testCase.expected,
        effectivePassed: effective === testCase.expected,
      };
      results.push(result);
      console.log(
        `${result.rawPassed ? "MODEL_PASS" : "MODEL_FAIL"} ` +
          `${result.effectivePassed ? "PIPE_PASS" : "PIPE_FAIL"} ${result.name}: ` +
          `model ${result.actual} (${Math.round(result.confidence * 100)}%), ` +
          `effective ${result.effective}, ` +
          `${result.elapsedMs}ms`,
      );
    } catch (error) {
      const result: EvaluationResult = {
        name: testCase.name,
        expected: testCase.expected,
        actual: "error",
        effective: "error",
        confidence: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        rawPassed: false,
        effectivePassed: false,
      };
      results.push(result);
      console.log(
        `MODEL_FAIL PIPE_FAIL ${result.name}: ` +
          `${error instanceof Error ? error.message : "unknown error"} ` +
          `${result.elapsedMs}ms`,
      );
    }
  }

  const rawPassed = results.filter((result) => result.rawPassed).length;
  const effectivePassed = results.filter(
    (result) => result.effectivePassed,
  ).length;
  const elapsed = results.reduce((total, result) => total + result.elapsedMs, 0);
  const sortedLatencies = results
    .map((result) => result.elapsedMs)
    .sort((left, right) => left - right);
  const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] ?? 0;
  const p95 =
    sortedLatencies[
      Math.min(
        sortedLatencies.length - 1,
        Math.floor(sortedLatencies.length * 0.95),
      )
    ] ?? 0;
  const intents: RequestIntent[] = [
    "conversation",
    "coding",
    "reasoning",
    "document",
    "vision",
    "research",
  ];
  const perIntent = intents.map((intent) => {
    const expected = results.filter((result) => result.expected === intent);
    const raw = expected.filter((result) => result.rawPassed).length;
    const effective = expected.filter(
      (result) => result.effectivePassed,
    ).length;
    console.log(
      `CLASS ${intent}: conditioned model ${raw}/${expected.length}, ` +
        `effective ${effective}/${expected.length}`,
    );
    return {
      raw: expected.length === 0 ? 0 : raw / expected.length,
      effective:
        expected.length === 0 ? 0 : effective / expected.length,
    };
  });
  const rawMacro =
    perIntent.reduce((total, value) => total + value.raw, 0) /
    perIntent.length;
  const effectiveMacro =
    perIntent.reduce((total, value) => total + value.effective, 0) /
    perIntent.length;
  const rawOverall = rawPassed / results.length;
  const effectiveOverall = effectivePassed / results.length;
  console.log(
    `SUMMARY ${model}: conditioned model ${rawPassed}/${results.length} ` +
      `(${Math.round((rawPassed / results.length) * 100)}%), ` +
      `effective ${effectivePassed}/${results.length} ` +
      `(${Math.round((effectivePassed / results.length) * 100)}%), ` +
      `macro conditioned model ${Math.round(rawMacro * 100)}%, ` +
      `macro effective ${Math.round(effectiveMacro * 100)}%, ` +
      `mean ${Math.round(elapsed / results.length)}ms, p50 ${p50}ms, p95 ${p95}ms`,
  );
  const minimumAnalyzerMacro = 0.8;
  const minimumAnalyzerPerClass = 0.8;
  const minimumEffectiveMacro = 1;
  const minimumAnalyzerOverall = 0.85;
  const minimumEffectiveOverall = 1;
  if (
    rawMacro < minimumAnalyzerMacro ||
    perIntent.some((value) => value.raw < minimumAnalyzerPerClass) ||
    effectiveMacro < minimumEffectiveMacro ||
    rawOverall < minimumAnalyzerOverall ||
    effectiveOverall < minimumEffectiveOverall ||
    results.some((result) => result.actual === "error")
  ) {
    console.error(
      `FAILED quality gate: requires conditioned model overall >= ${minimumAnalyzerOverall}, ` +
        `effective overall >= ${minimumEffectiveOverall}, ` +
        `conditioned model macro >= ${minimumAnalyzerMacro}, ` +
        `every conditioned model class >= ${minimumAnalyzerPerClass}, ` +
        `effective macro >= ${minimumEffectiveMacro}, and no errors.`,
    );
    process.exitCode = 1;
  }
}

await main();
