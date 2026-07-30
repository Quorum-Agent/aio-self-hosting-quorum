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
import {
  detectSoftwareReference,
  isNamedSoftwareFollowUp,
} from "./software-taxonomy.js";

const TIME_SENSITIVE_SUBJECT =
  String.raw`(?:news|events?|laws?|regulations?|prices?|weather|versions?|releases?|exchange rates?|schedules?|scores?|officeholders?|presidents?|ceos?)`;
const EXPLICIT_FRESHNESS_PATTERN = new RegExp(
  String.raw`(?:\b(?:latest|recent|live|current(?:ly)?|today|this week|up[- ]to[- ]date)\b[^.!?\n]{0,60}\b${TIME_SENSITIVE_SUBJECT}\b|\b${TIME_SENSITIVE_SUBJECT}\b[^.!?\n]{0,60}\b(?:latest|recent|live|current(?:ly)?|today|this week|up[- ]to[- ]date)\b)`,
  "i",
);
const CONTEXTUAL_CURRENT_PATTERN = new RegExp(
  String.raw`(?:\bcurrent(?:ly)?\b[^.!?\n]{0,60}\b${TIME_SENSITIVE_SUBJECT}\b|\b${TIME_SENSITIVE_SUBJECT}\b[^.!?\n]{0,60}\bcurrent(?:ly)?\b)`,
  "i",
);
const EXPLICIT_CHAT_PATTERN =
  /\b(tell me a joke|just chat|casual conversation|new topic|let'?s (?:just )?talk)\b/i;
const CODE_DOMAIN_PATTERN =
  /\b(compiler|stack trace|source code|codebase|repository|api endpoint|rest endpoint|database schema|unit tests?|http\s+[45]\d{2})\b/i;
const CODE_ACTION_PATTERN =
  /\b(write|implement|refactor|debug|fix|compile|program|code|containeri[sz]e|optimi[sz]e|review|test|add|change|edit|build|design|create|analy[sz]e|undo|use)\b/i;
const CODE_TARGET_PATTERN =
  /\b(code|function|method|class|interface|type|script|service|endpoint|query|component|bug|error|repository|module|package|algorithm|commit|array)\b/i;
const CODE_BLOCK_PATTERN = /```[\s\S]*```|(?:^|\n)\s*(?:const|let|var|def|fn|class|interface)\s+/i;
const REASONING_DOMAIN_PATTERN =
  /\b(equation|theorem|proof|prove|square root|sqrt|integral|derivative|probability|statistics|combinatorics|algebra|geometry|arithmetic|syllogism|logical|logic puzzle)\b/i;
const REASONING_ACTION_PATTERN =
  /\b(calculate|solve|derive|reason|analy[sz]e|evaluate|determine)\b/i;
const REASONING_TARGET_PATTERN =
  /\b(problem|equation|math(?:ematics)?|logic|argument|proof|puzzle|probability|claim|area|circle|radius|volume|distance|percentage)\b/i;
const MATH_EXPRESSION_PATTERN =
  /(?:\d|\bx\b)\s*(?:[+\-*/^=]|\b(?:plus|minus|times|divided by)\b)\s*(?:\d|\bx\b)/i;
const ANALYTICAL_DECISION_PATTERN =
  /\b(?:compare|evaluate|assess|weigh)\b[^.!?\n]{0,160}\b(?:architectures?|approaches?|options?|trade[- ]offs?|designs?|strategies?|patterns?)\b|\b(?:recommend|choose|decide)\b[^.!?\n]{0,160}\b(?:architecture|approach|option|design|strategy|pattern|starting point)\b/i;
const DOCUMENT_PATTERN =
  /\b(?:attached|this|the)\s+(?:pdf|document|invoice|contract|spreadsheet|attachment|file)\b|\b(?:summari[sz]e|extract|parse|review|read)\b[^.!?\n]{0,40}\b(?:pdf|document|invoice|contract|spreadsheet|attachment|file)\b/i;
const VISION_PATTERN =
  /\b(image|photo|picture|diagram|screenshot|visual|pcb)\b/i;
const EXPLICIT_RESEARCH_PATTERN =
  /\b(?:research|compare interpretations|search (?:the )?web|browse (?:the )?web|look (?:it |this |that )?up online)\b/i;
const EXPLICIT_WEB_REQUEST_PATTERN =
  /\b(?:search (?:the )?web|browse (?:the )?web|look (?:it |this |that )?up online|use (?:the )?internet|external (?:web )?sources?)\b/i;
const EVIDENCE_REQUEST_PATTERN =
  /\b(?:provide|include|cite|show|give)\b[^.!?\n]{0,40}\b(?:an?\s+|the\s+)?(?:sources?|citations?)\b|\bwhat (?:sources?|citations?)\b|\bsources?\s+(?:for|on|about|supporting)\b/i;
const NETWORK_DENIAL_PATTERN =
  /\b(?:(?:do not|don'?t|never)\s+(?:use|search|access|contact)|without\s+(?:using\s+|accessing\s+)?|no\s+)(?:the\s+)?(?:internet|web|network|online services?|external services?)\b|\boffline(?:[ -]only)?\b|\b(?:local[ -]only|only (?:my|the) local)\b/i;
const LOCAL_SCOPE_PATTERN =
  /\b(?:my|the|only)\s+local\s+(?:notes?|files?|documents?|database|sources?|context)\b|\blocal\s+(?:notes?|files?|documents?|database|sources?|context)\s+only\b/i;
const SENSITIVE_PATTERN =
  /\b(password|secret|private key|api[ _-]?key|credentials?|access[ _-]?token|bearer[ _-]?token|ssn|social security|medical|confidential|proprietary|account number|internal only|do not distribute|restricted data)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|\bsk-(?:[A-Za-z0-9_-]{10,})\b|\bsk_(?:live|test)_[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bauthorization\s*:\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b(?:accountkey|sharedaccesssignature)\s*=\s*[^;\s]+|\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^@\s/]+:[^@\s/]+@|\b\d{3}-\d{2}-\d{4}\b/i;
const PAYMENT_CARD_CANDIDATE_PATTERN = /(?:\d[ -]*?){13,19}/g;
const COURTESY_PREFIX_PATTERN =
  /^(?:(?:thank you|thanks(?:\s+(?:so much|a lot))?|okay|ok|great|got it|understood|makes sense|perfect)[\s.!,:;-]+)+/i;
const FOLLOW_UP_PATTERN =
  /^(?:(?:and|also|now|then|next|okay,?\s+now)\b|what(?:'s| is)\s+(?:the\s+)?(?:latest|current)\b|(?:what|how) about\s+(?:(?:it|that|this|those|them)\b|(?:for|in|on|with|using|doing|implementing|running)\b)|(?:please\s+)?(?:continue|retry|redo)(?:\s+(?:(?:with\s+)?(?:it|that|this|those|them)|(?:the|this|that)\s+[a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,4}))?\s*[.!?]*$|(?:please\s+)?(?:keep going|go on|carry on)\s*[.!?]*$|(?:please\s+)?(?:make|change|fix|explain|summari[sz]e|add|remove|update|use|adapt|integrate|convert|port)\s+(?:it|that|this|those|them)\b|(?:why|how|are you sure)\??$)/i;
const COMPARATIVE_FOLLOW_UP_PATTERN =
  /^(?:(?:are|is)\s+there\s+(?:(?:any|a)\s+)?(?:better|other|alternative)\s+(?:ways?|options?|approach(?:es)?|methods?|solutions?)|(?:what|any)\s+(?:other|better|alternative)\s+(?:ways?|options?|approach(?:es)?|methods?|solutions?)(?:\s+are\s+there)?|(?:any\s+)?alternatives?|what\s+else)\??$/i;
const MODAL_REFERENTIAL_FOLLOW_UP_PATTERN =
  /^(?:(?:can|could|would|should|will|may|might|does|do|did|is|are|was|were)\s+(?:this|that|it|these|those|they)\b|(?:can|could|would|should|may|might)\s+(?:i|we|you)\s+(?:use|apply|adapt|integrate|implement|extend|reuse|port)\s+(?:this|that|it|these|those|them)\b)/i;

function normalizedFollowUpPrompt(prompt: string): string {
  return prompt.trim().replace(COURTESY_PREFIX_PATTERN, "").trim();
}

function isContextualFollowUp(prompt: string): boolean {
  const normalized = normalizedFollowUpPrompt(prompt);
  return (
    FOLLOW_UP_PATTERN.test(normalized) ||
    COMPARATIVE_FOLLOW_UP_PATTERN.test(normalized) ||
    MODAL_REFERENTIAL_FOLLOW_UP_PATTERN.test(normalized)
  );
}

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
  const softwareReference = detectSoftwareReference(prompt);
  const codingSignal =
    softwareReference !== undefined ||
    CODE_DOMAIN_PATTERN.test(prompt) ||
    CODE_BLOCK_PATTERN.test(prompt) ||
    (CODE_ACTION_PATTERN.test(prompt) && CODE_TARGET_PATTERN.test(prompt));

  if (EXPLICIT_CHAT_PATTERN.test(prompt)) {
    return {
      intent: "conversation",
      confidence: 0.98,
      requiresFreshness: false,
      explicitReset: true,
    };
  }
  if (
    EXPLICIT_RESEARCH_PATTERN.test(prompt) ||
    EXPLICIT_WEB_REQUEST_PATTERN.test(prompt) ||
    freshInformationRequired
  ) {
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

  if (codingSignal) {
    return {
      intent: "coding",
      confidence:
        softwareReference === "strong" || CODE_DOMAIN_PATTERN.test(prompt)
          ? 0.94
          : softwareReference === "contextual"
            ? 0.82
            : 0.86,
      requiresFreshness: false,
      explicitReset: false,
    };
  }

  if (EVIDENCE_REQUEST_PATTERN.test(prompt)) {
    return {
      intent: "research",
      confidence: 0.9,
      requiresFreshness: false,
      explicitReset: false,
    };
  }

  const reasoningSignal =
    ANALYTICAL_DECISION_PATTERN.test(prompt) ||
    REASONING_DOMAIN_PATTERN.test(prompt) ||
    MATH_EXPRESSION_PATTERN.test(prompt) ||
    (REASONING_ACTION_PATTERN.test(prompt) &&
      REASONING_TARGET_PATTERN.test(prompt));
  if (reasoningSignal) {
    return {
      intent: "reasoning",
      confidence: ANALYTICAL_DECISION_PATTERN.test(prompt)
        ? 0.9
        : REASONING_DOMAIN_PATTERN.test(prompt)
          ? 0.92
          : 0.84,
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
  messages: ChatMessage[],
): IntentClassification & {
  source: RequestRequirements["intentSource"];
} {
  const userMessages = messages.filter(
    (message) => message.role === "user" && message.content.trim(),
  );
  const current = classifyPrompt(userMessages.at(-1)?.content ?? "");
  const latestPrompt = userMessages.at(-1)?.content.trim() ?? "";
  const contextualFollowUp = isContextualFollowUp(latestPrompt);
  const namedSoftwareFollowUp = isNamedSoftwareFollowUp(latestPrompt);
  if (
    current.intent !== "conversation" ||
    current.explicitReset ||
    (!contextualFollowUp && !namedSoftwareFollowUp)
  ) {
    return {
      ...current,
      source: current.intent === "conversation" ? "default" : "current",
    };
  }

  const latestUserIndex = messages.findLastIndex(
    (message) => message.role === "user" && message.content.trim(),
  );
  const previousExecution = messages
    .slice(0, latestUserIndex)
    .reverse()
    .find((message) => message.role === "assistant")
    ?.execution?.plan.analysis;
  if (previousExecution) {
    if (
      previousExecution.intent !== "conversation" &&
      (!namedSoftwareFollowUp || previousExecution.intent === "coding")
    ) {
      return {
        intent: previousExecution.intent,
        confidence: Math.min(previousExecution.confidence, 0.78),
        requiresFreshness: false,
        explicitReset: false,
        source: "conversation",
      };
    }
  }

  for (let index = userMessages.length - 2; index >= 0; index -= 1) {
    const previous = userMessages[index];
    if (!previous) continue;
    const classification = classifyPrompt(previous.content);
    if (classification.explicitReset) break;
    if (
      classification.intent !== "conversation" &&
      (!namedSoftwareFollowUp || classification.intent === "coding")
    ) {
      return {
        ...classification,
        confidence: Math.min(classification.confidence, 0.78),
        source: "conversation",
      };
    }
    if (!isContextualFollowUp(previous.content)) break;
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
  if (intent === "research") {
    capabilities.push("reasoning");
    const latestUserPrompt =
      [...messages]
        .reverse()
        .find((message) => message.role === "user" && message.content.trim())
        ?.content ?? "";
    const priorPromptAuthorizesWeb =
      classification.source === "conversation" &&
      [...messages]
        .slice(0, -1)
        .reverse()
        .filter((message) => message.role === "user" && message.content.trim())
        .some(
          (message) =>
            !NETWORK_DENIAL_PATTERN.test(message.content) &&
            !LOCAL_SCOPE_PATTERN.test(message.content) &&
            (requiresFreshness(message.content) ||
              EXPLICIT_WEB_REQUEST_PATTERN.test(message.content) ||
              EVIDENCE_REQUEST_PATTERN.test(message.content)),
        );
    const currentPromptBlocksWeb =
      NETWORK_DENIAL_PATTERN.test(latestUserPrompt) ||
      LOCAL_SCOPE_PATTERN.test(latestUserPrompt);
    const currentPromptAuthorizesWeb =
      !currentPromptBlocksWeb &&
      (classification.requiresFreshness ||
        EXPLICIT_WEB_REQUEST_PATTERN.test(latestUserPrompt) ||
        EVIDENCE_REQUEST_PATTERN.test(latestUserPrompt));
    if (
      classification.source !== "classifier" &&
      !currentPromptBlocksWeb &&
      (currentPromptAuthorizesWeb || priorPromptAuthorizesWeb)
    ) {
      capabilities.push("web");
    }
  }

  return {
    intent,
    intentConfidence: classification.confidence,
    intentSource: classification.source,
    capabilities,
    requiresFreshness: classification.requiresFreshness,
    containsSensitiveData: messages.some((message) =>
      containsSensitiveContent(message.content),
    ),
  };
}

export function containsSensitiveContent(content: string): boolean {
  if (SENSITIVE_PATTERN.test(content)) return true;
  const candidates = content.match(PAYMENT_CARD_CANDIDATE_PATTERN) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let value = Number(digits[index]);
      if (doubleDigit) {
        value *= 2;
        if (value > 9) value -= 9;
      }
      sum += value;
      doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
  });
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

    const classification = classifyConversation(input.messages);
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
    const protectedConversationContext =
      request.requirements.intentSource === "conversation" &&
      heuristic.intent !== "conversation";
    const conflictingStrongHeuristic =
      heuristic.intent !== analysis.intent &&
      (heuristic.confidence >= 0.84 || protectedConversationContext);
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
    const requirements = deriveRequirements(request.messages, {
      intent: selected.intent,
      confidence: selected.confidence,
      requiresFreshness: request.requirements.requiresFreshness,
      explicitReset: false,
      source: selected.source,
    });
    if (
      selected.intent === "research" &&
      request.requirements.capabilities.includes("web") &&
      !requirements.capabilities.includes("web")
    ) {
      requirements.capabilities.push("web");
    }

    return {
      ...request,
      analysis: mergedAnalysis,
      requirements,
    };
  }
}
