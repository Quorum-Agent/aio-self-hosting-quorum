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

export type ExecutionLocation = "device" | "local" | "cloud";

export type Capability =
  | "chat"
  | "reasoning"
  | "coding"
  | "vision"
  | "documents"
  | "web"
  | "tools";

export interface ModelDescriptor {
  id: Id;
  label: string;
  provider: string;
  location: Exclude<ExecutionLocation, "device">;
  transport: "in_process" | "loopback" | "remote";
  capabilities: Capability[];
  contextWindow: number;
  qualityRating: number;
  specialties?: Capability[];
  available: boolean;
  costPerMillionTokens?: number;
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
  capabilities: Capability[];
  requiresFreshness: boolean;
  containsSensitiveData: boolean;
}

export interface CompiledRequest {
  id: Id;
  conversationId: Id;
  messages: ChatMessage[];
  prompt: string;
  policy: PolicyMode;
  requirements: RequestRequirements;
}

export interface PlanStep {
  id: Id;
  label: string;
  kind: "compile" | "policy" | "retrieval" | "model" | "synthesis";
  location: ExecutionLocation;
  modelId?: Id;
}

export interface TaskPlan {
  id: Id;
  requestId: Id;
  route: "local" | "cloud";
  modelId: Id;
  rationale: string;
  steps: PlanStep[];
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
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly model: ModelDescriptor;
  stream(input: ModelStreamInput): AsyncIterable<string>;
}
