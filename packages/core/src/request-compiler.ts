import { randomUUID } from "node:crypto";

import type {
  ChatMessage,
  ChatRequest,
  CompiledRequest,
  PromptAnalyzer,
  PromptAnalyzerResult,
  RequestAnalysis,
  RequestIntent,
  RequestRequirements,
} from "./types.js";

const EXPLICIT_FRESHNESS_PATTERN =
  /\b(latest|today|this week|recent|news|live|up[- ]to[- ]date)\b/i;
const TIME_SENSITIVE_SUBJECT =
  String.raw`(?:news|events?|laws?|regulations?|prices?|weather|versions?|releases?|exchange rates?|schedules?|scores?|officeholders?|presidents?|ceos?)`;
const CONTEXTUAL_CURRENT_PATTERN = new RegExp(
  String.raw`(?:\bcurrent(?:ly)?\b[^.!?\n]{0,60}\b${TIME_SENSITIVE_SUBJECT}\b|\b${TIME_SENSITIVE_SUBJECT}\b[^.!?\n]{0,60}\bcurrent(?:ly)?\b)`,
  "i",
);
const EXPLICIT_CHAT_PATTERN =
  /\b(tell me a joke|just chat|casual conversation|new topic|let'?s (?:just )?talk)\b/i;
const CODE_DOMAIN_PATTERN =
  /\b(typescript|javascript|python|rust|golang|sql|react|node(?:\.js)?|git|compiler|stack trace|source code|codebase|repository|api endpoint|rest endpoint|graphql|database schema|unit tests?)\b|c\+\+|c#/i;
const CODE_ACTION_PATTERN =
  /\b(write|implement|refactor|debug|fix|compile|program|code|optimi[sz]e|review|test|add|change|edit|build|design|create|analy[sz]e)\b/i;
const CODE_TARGET_PATTERN =
  /\b(code|function|method|class|interface|type|script|service|endpoint|query|component|tests?|bug|error|repository|module|package|algorithm)\b/i;
const CODE_BLOCK_PATTERN = /```[\s\S]*```|(?:^|\n)\s*(?:const|let|var|def|fn|class|interface)\s+/i;
const REASONING_DOMAIN_PATTERN =
  /\b(equation|theorem|proof|prove|square root|sqrt|integral|derivative|probability|statistics|combinatorics|algebra|geometry|arithmetic|syllogism|logical|logic puzzle)\b/i;
const REASONING_ACTION_PATTERN =
  /\b(calculate|solve|derive|reason|analy[sz]e|evaluate|determine)\b/i;
const REASONING_TARGET_PATTERN =
  /\b(problem|equation|math(?:ematics)?|logic|argument|proof|puzzle|probability|claim|area|circle|radius|volume|distance|percentage)\b/i;
const MATH_EXPRESSION_PATTERN =
  /(?:\d|\bx\b)\s*(?:[+\-*/^=]|\b(?:plus|minus|times|divided by)\b)\s*(?:\d|\bx\b)/i;
const DOCUMENT_PATTERN =
  /\b(?:attached|this|the)\s+(?:pdf|document|invoice|contract|spreadsheet|attachment|file)\b|\b(?:summari[sz]e|extract|parse|review|read)\b[^.!?\n]{0,40}\b(?:pdf|document|invoice|contract|spreadsheet|attachment|file)\b/i;
const VISION_PATTERN =
  /\b(image|photo|picture|diagram|screenshot|visual|pcb)\b/i;
const RESEARCH_PATTERN =
  /\b(research|sources?|citations?|compare interpretations|search the web)\b/i;
const SENSITIVE_PATTERN =
  /\b(password|secret|private key|api[ _-]?key|credentials?|access[ _-]?token|bearer[ _-]?token|ssn|social security|medical|confidential|proprietary|account number)\b|AKIA[0-9A-Z]{16}|\bsk-[A-Za-z0-9_-]{10,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bauthorization\s*:\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b\d{3}-\d{2}-\d{4}\b/i;
const FOLLOW_UP_PATTERN =
  /^(?:(?:and|also|now|then|next|okay,?\s+now)\b|(?:what|how) about\b|(?:please\s+)?(?:make|change|fix|explain|summari[sz]e|continue|retry|redo|add|remove|update)\s+(?:it|that|this|those|them)\b|(?:why|how|are you sure)\??$)/i;

interface IntentClassification {
  intent: RequestIntent;
  confidence: number;
  requiresFreshness: boolean;
  explicitReset: boolean;
}

function requiresFreshness(prompt: string): boolean {
  return (
    EXPLICIT_FRESHNESS_PATTERN.test(prompt) ||
    CONTEXTUAL_CURRENT_PATTERN.test(prompt)
  );
}

function classifyPrompt(prompt: string): IntentClassification {
  const freshInformationRequired = requiresFreshness(prompt);

  if (EXPLICIT_CHAT_PATTERN.test(prompt)) {
    return {
      intent: "conversation",
      confidence: 0.98,
      requiresFreshness: false,
      explicitReset: true,
    };
  }
  if (RESEARCH_PATTERN.test(prompt) || freshInformationRequired) {
    return {
      intent: "research",
      confidence: 0.98,
      requiresFreshness: freshInformationRequired,
      explicitReset: false,
    };
  }
  if (VISION_PATTERN.test(prompt)) {
    return {
      intent: "vision",
      confidence: 0.94,
      requiresFreshness: false,
      explicitReset: false,
    };
  }
  if (DOCUMENT_PATTERN.test(prompt)) {
    return {
      intent: "document",
      confidence: 0.9,
      requiresFreshness: false,
      explicitReset: false,
    };
  }

  const codingSignal =
    CODE_DOMAIN_PATTERN.test(prompt) ||
    CODE_BLOCK_PATTERN.test(prompt) ||
    (CODE_ACTION_PATTERN.test(prompt) && CODE_TARGET_PATTERN.test(prompt));
  if (codingSignal) {
    return {
      intent: "coding",
      confidence: CODE_DOMAIN_PATTERN.test(prompt) ? 0.94 : 0.86,
      requiresFreshness: false,
      explicitReset: false,
    };
  }

  const reasoningSignal =
    REASONING_DOMAIN_PATTERN.test(prompt) ||
    MATH_EXPRESSION_PATTERN.test(prompt) ||
    (REASONING_ACTION_PATTERN.test(prompt) &&
      REASONING_TARGET_PATTERN.test(prompt));
  if (reasoningSignal) {
    return {
      intent: "reasoning",
      confidence: REASONING_DOMAIN_PATTERN.test(prompt) ? 0.92 : 0.84,
      requiresFreshness: false,
      explicitReset: false,
    };
  }

  return {
    intent: "conversation",
    confidence: 0.5,
    requiresFreshness: false,
    explicitReset: false,
  };
}

function classifyConversation(
  userMessages: ChatMessage[],
): IntentClassification & {
  source: RequestRequirements["intentSource"];
} {
  const current = classifyPrompt(userMessages.at(-1)?.content ?? "");
  if (
    current.intent !== "conversation" ||
    current.explicitReset ||
    !FOLLOW_UP_PATTERN.test(userMessages.at(-1)?.content.trim() ?? "")
  ) {
    return {
      ...current,
      source: current.intent === "conversation" ? "default" : "current",
    };
  }

  const previous = userMessages.at(-2);
  if (!previous) return { ...current, source: "default" };
  const classification = classifyPrompt(previous.content);
  if (
    !classification.explicitReset &&
    classification.intent !== "conversation"
  ) {
    return {
      ...classification,
      confidence: Math.min(classification.confidence, 0.78),
      source: "conversation",
    };
  }

  return { ...current, source: "default" };
}

function deriveRequirements(
  messages: ChatMessage[],
  classification: IntentClassification & {
    source: RequestRequirements["intentSource"];
  },
): RequestRequirements {
  const intent = classification.intent;
  const capabilities: RequestRequirements["capabilities"] = ["chat"];

  if (intent === "coding") capabilities.push("coding");
  if (intent === "reasoning") capabilities.push("reasoning");
  if (intent === "document") capabilities.push("documents");
  if (intent === "vision") capabilities.push("vision");
  if (intent === "research") capabilities.push("reasoning", "web");

  return {
    intent,
    intentConfidence: classification.confidence,
    intentSource: classification.source,
    capabilities,
    requiresFreshness: classification.requiresFreshness,
    containsSensitiveData: messages.some((message) =>
      SENSITIVE_PATTERN.test(message.content),
    ),
  };
}

function compactSummary(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  return singleLine.length > 240
    ? `${singleLine.slice(0, 239)}…`
    : singleLine;
}

function validAnalyzerResult(
  analysis: PromptAnalyzerResult,
): PromptAnalyzerResult {
  if (
    !Number.isFinite(analysis.confidence) ||
    analysis.confidence < 0 ||
    analysis.confidence > 1
  ) {
    throw new Error("Prompt analyzer returned an invalid confidence.");
  }
  const taskSummary = compactSummary(analysis.taskSummary);
  if (!taskSummary) {
    throw new Error("Prompt analyzer returned an empty task summary.");
  }
  return { ...analysis, taskSummary };
}

export class RequestCompiler {
  compile(input: ChatRequest): CompiledRequest {
    const userMessages = input.messages.filter(
      (message) => message.role === "user" && message.content.trim(),
    );
    const prompt = userMessages.at(-1)?.content.trim() ?? "";

    if (!prompt) {
      throw new Error("A non-empty user message is required.");
    }

    const classification = classifyConversation(userMessages);
    return {
      id: randomUUID(),
      conversationId: input.conversationId,
      messages: input.messages,
      prompt,
      policy: input.policy,
      verbosity: input.verbosity ?? "standard",
      analysis: {
        source: "heuristic",
        intent: classification.intent,
        confidence: classification.confidence,
        taskSummary: compactSummary(prompt),
      },
      requirements: deriveRequirements(input.messages, classification),
    };
  }

  applyPromptAnalysis(
    request: CompiledRequest,
    analyzer: Pick<PromptAnalyzer, "id" | "label">,
    incoming: PromptAnalyzerResult,
  ): CompiledRequest {
    const analysis = validAnalyzerResult(incoming);
    const heuristic = request.analysis;
    const conflictingStrongHeuristic =
      heuristic.intent !== analysis.intent && heuristic.confidence >= 0.84;
    const analyzerIsUsable = analysis.confidence >= 0.65;
    const useAnalyzer = analyzerIsUsable && !conflictingStrongHeuristic;
    const selected = useAnalyzer
      ? {
          intent: analysis.intent,
          confidence: analysis.confidence,
          source: "classifier" as const,
        }
      : {
          intent: heuristic.intent,
          confidence: heuristic.confidence,
          source: request.requirements.intentSource,
        };
    const mergedAnalysis: RequestAnalysis = {
      source: useAnalyzer ? "local_model" : "hybrid",
      intent: selected.intent,
      confidence: selected.confidence,
      taskSummary: useAnalyzer
        ? analysis.taskSummary
        : heuristic.taskSummary,
      analyzer: {
        modelId: analyzer.id,
        modelLabel: analyzer.label,
        intent: analysis.intent,
        confidence: analysis.confidence,
      },
    };

    return {
      ...request,
      analysis: mergedAnalysis,
      requirements: deriveRequirements(request.messages, {
        intent: selected.intent,
        confidence: selected.confidence,
        requiresFreshness: request.requirements.requiresFreshness,
        explicitReset: false,
        source: selected.source,
      }),
    };
  }
}
