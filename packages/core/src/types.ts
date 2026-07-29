export type Id = string;

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: Id;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export type PolicyMode =
  | "private"
  | "balanced"
  | "quality"
  | "offline"
  | "cost_controlled";

export type ResponseVerbosity = "concise" | "standard" | "detailed";

export type ExecutionLocation = "device" | "local" | "cloud";

export type Capability =
  | "chat"
  | "reasoning"
  | "coding"
  | "vision"
  | "documents"
  | "web"
  | "tools";

export type LocalModelRole = "general" | "coding" | "reasoning";

export interface ModelInferenceSettings {
  reasoningEffort?: "none" | "low" | "medium" | "high";
  maxOutputTokens?: number;
}

export interface ModelDescriptor {
  id: Id;
  label: string;
  provider: string;
  role?: LocalModelRole;
  location: Exclude<ExecutionLocation, "device">;
  transport: "in_process" | "loopback" | "remote";
  capabilities: Capability[];
  contextWindow: number;
  qualityRating: number;
  specialties?: Capability[];
  inference?: ModelInferenceSettings;
  available: boolean;
  costPerMillionTokens?: number;
}

export interface LocalModelRoleStatus {
  role: LocalModelRole;
  configuredModel: string;
  modelId?: Id;
  required: boolean;
  available: boolean;
}

export interface LocalRuntimeStatus {
  state: "ready" | "degraded" | "unavailable";
  endpointConnected: boolean;
  roles: LocalModelRoleStatus[];
  promptAnalyzer?: {
    configuredModel: string;
    modelId?: Id;
    available: boolean;
  };
}

export interface PolicyDefinition {
  id: PolicyMode;
  label: string;
  description: string;
  allowNetwork: boolean;
  allowCloudModels: boolean;
  preferLocal: boolean;
  cloudBudgetUsd?: number;
}

export type RequestIntent =
  | "conversation"
  | "reasoning"
  | "coding"
  | "document"
  | "vision"
  | "research";

export interface RequestRequirements {
  intent: RequestIntent;
  intentConfidence: number;
  intentSource: "current" | "conversation" | "default" | "classifier";
  capabilities: Capability[];
  requiresFreshness: boolean;
  containsSensitiveData: boolean;
}

export interface PromptAnalyzerResult {
  intent: RequestIntent;
  confidence: number;
  taskSummary: string;
}

export interface PromptAnalyzerInput {
  messages: ChatMessage[];
  baseline: RequestAnalysis;
}

export interface PromptAnalyzer {
  readonly id: Id;
  readonly label: string;
  analyze(
    input: PromptAnalyzerInput,
    signal?: AbortSignal,
  ): Promise<PromptAnalyzerResult>;
}

export interface RequestAnalysis {
  source: "heuristic" | "local_model" | "hybrid";
  intent: RequestIntent;
  confidence: number;
  taskSummary: string;
  analyzer?: {
    modelId: Id;
    modelLabel: string;
    intent: RequestIntent;
    confidence: number;
  };
}

export interface CompiledRequest {
  id: Id;
  conversationId: Id;
  messages: ChatMessage[];
  prompt: string;
  policy: PolicyMode;
  verbosity: ResponseVerbosity;
  analysis: RequestAnalysis;
  requirements: RequestRequirements;
}

export interface PlanStep {
  id: Id;
  label: string;
  kind:
    | "compile"
    | "classification"
    | "policy"
    | "retrieval"
    | "model"
    | "synthesis";
  location: ExecutionLocation;
  modelId?: Id;
}

export interface ExecutionAttempt {
  modelId: Id;
  route: "local" | "cloud";
  status: "completed" | "failed";
  contextMayHaveBeenTransmitted: boolean;
  detail?: string;
}

export interface TaskPlan {
  id: Id;
  requestId: Id;
  policy: PolicyMode;
  verbosity: ResponseVerbosity;
  analysis: RequestAnalysis;
  route: "local" | "cloud";
  modelId: Id;
  rationale: string;
  steps: PlanStep[];
  degraded?: boolean;
  fallbackFromModelId?: Id;
  attempts?: ExecutionAttempt[];
  cloudDisclosure?: string;
}

export type TraceStatus = "pending" | "running" | "completed" | "failed";

export interface ExecutionTrace {
  id: Id;
  requestId: Id;
  stepId: Id;
  label: string;
  kind: PlanStep["kind"];
  location: ExecutionLocation;
  status: TraceStatus;
  detail?: string;
  modelId?: Id;
  startedAt: string;
  completedAt?: string;
}

export interface ChatRequest {
  conversationId: Id;
  messages: ChatMessage[];
  policy: PolicyMode;
  verbosity?: ResponseVerbosity;
}

export interface ChatResult {
  requestId: Id;
  conversationId: Id;
  message: ChatMessage;
  plan: TaskPlan;
}

export type OrchestrationEvent =
  | { type: "trace"; trace: ExecutionTrace }
  | { type: "plan"; plan: TaskPlan }
  | { type: "delta"; content: string }
  | { type: "result"; result: ChatResult }
  | { type: "error"; message: string; recoverable: boolean };

export interface ModelStreamInput {
  messages: ChatMessage[];
  request: CompiledRequest;
  runtimeModels: ModelDescriptor[];
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly model: ModelDescriptor;
  stream(input: ModelStreamInput): AsyncIterable<string>;
}
