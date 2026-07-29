import { randomUUID } from "node:crypto";

import type {
  ChatRequest,
  CompiledRequest,
  RequestIntent,
  RequestRequirements,
} from "./types.js";

const FRESHNESS_PATTERN =
  /\b(latest|current|currently|today|this week|recent|news|live|up[- ]to[- ]date)\b/i;
const CODE_PATTERN =
  /\b(code|function|class|typescript|javascript|python|rust|compile|repository|bug|api)\b/i;
const DOCUMENT_PATTERN =
  /\b(pdf|document|invoice|contract|spreadsheet|attachment|file)\b/i;
const VISION_PATTERN =
  /\b(image|photo|picture|diagram|screenshot|visual|pcb)\b/i;
const RESEARCH_PATTERN =
  /\b(research|sources?|citations?|compare interpretations|search the web)\b/i;
const SENSITIVE_PATTERN =
  /\b(password|secret|private key|ssn|social security|medical|confidential|proprietary)\b/i;

function detectIntent(prompt: string): RequestIntent {
  if (RESEARCH_PATTERN.test(prompt) || FRESHNESS_PATTERN.test(prompt)) return "research";
  if (VISION_PATTERN.test(prompt)) return "vision";
  if (DOCUMENT_PATTERN.test(prompt)) return "document";
  if (CODE_PATTERN.test(prompt)) return "coding";
  return "conversation";
}

function deriveRequirements(prompt: string): RequestRequirements {
  const intent = detectIntent(prompt);
  const capabilities: RequestRequirements["capabilities"] = ["chat"];

  if (intent === "coding") capabilities.push("coding");
  if (intent === "document") capabilities.push("documents");
  if (intent === "vision") capabilities.push("vision");
  if (intent === "research") capabilities.push("reasoning", "web");

  return {
    intent,
    capabilities,
    requiresFreshness: FRESHNESS_PATTERN.test(prompt),
    containsSensitiveData: SENSITIVE_PATTERN.test(prompt),
  };
}

export class RequestCompiler {
  compile(input: ChatRequest): CompiledRequest {
    const prompt =
      [...input.messages].reverse().find((message) => message.role === "user")?.content.trim() ??
      "";

    if (!prompt) {
      throw new Error("A non-empty user message is required.");
    }

    return {
      id: randomUUID(),
      conversationId: input.conversationId,
      messages: input.messages,
      prompt,
      policy: input.policy,
      requirements: deriveRequirements(prompt),
    };
  }
}
