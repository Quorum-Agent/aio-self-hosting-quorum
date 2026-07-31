export type Id = string;

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: Id;
  role: MessageRole;
  content: string;
  createdAt: string;
  provenance?: "web_grounded" | "hub_synthesized";
  execution?: MessageExecutionRecord;
}

export type PolicyMode =
  | "private"
  | "balanced"
  | "quality"
  | "offline"
  | "cost_controlled";

export type ResponseVerbosity = "concise" | "standard" | "detailed";

/**
 * Where execution happens, ordered by how far the conversation travels.
 *
 * `local` means "does not leave your device" — loopback only. The union was
 * previously `device | local | cloud`, which could not express a peer on your
 * own network or a server you rent, yet every privacy guarantee keys off it.
 * The gap was masked because loopback is enforced elsewhere, so the
 * enforcement was doing work the type should do.
 *
 * `remote` and `cloud` differ in *who controls the stack*, not in network
 * exposure: a self-hosted llama.cpp on rented hardware runs your weights with
 * no retention policy, while a vendor API does not. Someone who refuses vendor
 * APIs on principle may still accept rented GPU, and the old union forced
 * those into one bucket.
 *
 * The order is meaningful. `EXECUTION_LOCATIONS` below is the ordering, and
 * policies express what they permit as a ceiling within it.
 */
export type ExecutionLocation =
  | "device"
  | "local"
  | "network"
  | "remote"
  | "cloud";

/** Ordered nearest-to-furthest. Index is the tier; compare, do not equate. */
export const EXECUTION_LOCATIONS = [
  "device",
  "local",
  "network",
  "remote",
  "cloud",
] as const satisfies readonly ExecutionLocation[];

/** How far a location is from the device. Higher travels further. */
export function locationTier(location: ExecutionLocation): number {
  return EXECUTION_LOCATIONS.indexOf(location);
}

/**
 * Whether execution at this location puts conversation content off the device.
 *
 * The single source of truth for that question. It was previously written
 * inline as `location === "cloud"` at five independent sites — four in the
 * orchestrator and one in the web view — each a separate chance to be wrong,
 * and each silently answering "no" for any tier added later.
 */
export function leavesDevice(location: ExecutionLocation): boolean {
  return locationTier(location) > locationTier("local");
}

/**
 * How far a model actually reaches, which is not always what it declares.
 *
 * `ModelDescriptor.location` excludes `"device"`, so an in-process model calls
 * itself `local` even though it never opens a socket — it runs inside this
 * process. Treating transport as authoritative here is what lets `offline`
 * express itself as a ceiling of `device` and admit exactly the in-process
 * scaffold, rather than needing the planner to special-case the policy by name
 * and then check transport separately.
 */
export function modelReach(model: {
  location: Exclude<ExecutionLocation, "device">;
  transport: "in_process" | "loopback" | "remote";
}): ExecutionLocation {
  return model.transport === "in_process" ? "device" : model.location;
}

export type Capability =
  | "chat"
  | "reasoning"
  | "coding"
  | "vision"
  | "documents"
  | "web"
  | "tools";

export type LocalModelRole = "general" | "coding" | "reasoning";

// How many models answer one request. `route` selects a single model, which
// answers the user directly. `relay` has a spoke draft the answer and a hub
// rewrite it, so the user always reads one voice regardless of which spoke ran.
export type OrchestrationMode = "route" | "relay";

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
  /**
   * The furthest tier inference may travel.
   *
   * Replaces `allowCloudModels`. A ceiling rather than a flag because the
   * question is "how far", and a boolean could only answer it while there were
   * exactly two answers. It also turns `offline` from a policy special-cased
   * **by name** in the planner into a policy that simply declares `device`.
   */
  inferenceCeiling: ExecutionLocation;
  /**
   * The furthest tier a tool (today: web search) may travel, or `"none"`.
   *
   * Replaces `allowNetwork`. This is a *separate* axis from inference — the
   * old booleans happened to agree in all five policies, but they answer
   * different questions, and collapsing them into one ceiling would tie a
   * search engine's reachability to a model's.
   */
  toolCeiling: ExecutionLocation | "none";
  /** A sort preference, not a permission. Unchanged. */
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
  sensitiveDataCategories: SensitiveDataCategory[];
  containsWebGroundedData: boolean;
}

export type SensitiveDataCategory =
  | "credentials"
  | "private_key"
  | "financial"
  | "government_id"
  | "personal_contact"
  | "health"
  | "confidential";

export interface PromptAnalyzerResult {
  intent: RequestIntent;
  confidence: number;
  taskSummary: string;
}

export interface PromptAnalyzerInput {
  messages: ChatMessage[];
  baseline: RequestAnalysis;
  baselineIntentSource: RequestRequirements["intentSource"];
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
  // Which pipeline stage ran, when more than one model answers. Absent under
  // route, where a model change can only mean a fallback.
  stage?: "draft" | "synthesis";
  /** Where this attempt actually ran. */
  route: Exclude<ExecutionLocation, "device">;
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
  /**
   * The furthest tier any step of this plan reaches — a maximum, not the
   * selected model's location.
   *
   * It was the spoke's location, which is why a cloud hub behind a local spoke
   * would have reported `local` and emitted no disclosure. Deriving it from
   * every step means hub, spoke and tool are all covered by one rule instead
   * of each needing its own guard.
   */
  route: Exclude<ExecutionLocation, "device">;
  // The model whose words reach the user. Under relay that is the hub, and
  // spokeModelId names the model that drafted for it.
  modelId: Id;
  spokeModelId?: Id;
  // Relay was planned and did not happen: the hub failed, was unreachable, or
  // lost its scheduler slot, and the draft was delivered instead. A flag
  // rather than a rationale suffix, so a busy instance quietly serving route
  // traffic is detectable rather than only readable.
  synthesisDegraded?: boolean;
  rationale: string;
  steps: PlanStep[];
  degraded?: boolean;
  fallbackFromModelId?: Id;
  attempts?: ExecutionAttempt[];
  cloudDisclosure?: string;
  safety?: {
    sensitiveDataCategories: SensitiveDataCategory[];
    containsWebGroundedData: boolean;
  };
  webSearch?: {
    provider: string;
    query: string;
    contextMayHaveLeftDevice: boolean;
    sources: WebSearchSource[];
    attempts?: WebSearchAttempt[];
  };
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

export interface MessageExecutionRecord {
  plan: TaskPlan;
  traces: ExecutionTrace[];
  startedAt: number;
  completedAt: number;
  status?: "running" | "completed" | "failed" | "cancelled";
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
  | {
      type: "error";
      message: string;
      recoverable: boolean;
      plan?: TaskPlan;
      partialContent?: string;
      executionMessage?: ChatMessage;
    };

export interface ModelStreamInput {
  messages: ChatMessage[];
  request: CompiledRequest;
  runtimeModels: ModelDescriptor[];
  runtimeTools: RuntimeToolDescriptor[];
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly model: ModelDescriptor;
  stream(input: ModelStreamInput): AsyncIterable<string>;
}

export interface RuntimeToolDescriptor {
  id: Id;
  label: string;
  capabilities: Capability[];
  location: Exclude<ExecutionLocation, "device">;
  available: boolean;
  contextMayLeaveDevice: boolean;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchSource {
  title: string;
  url: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  provider?: string;
  attempts?: WebSearchAttempt[];
}

export interface WebSearchAttempt {
  provider: string;
  status: "running" | "completed" | "failed";
  detail?: string;
}

export interface WebSearchProvider {
  readonly tool: RuntimeToolDescriptor;
  search(
    query: string,
    signal?: AbortSignal,
    onAttempt?: (
      attempt: WebSearchAttempt,
    ) => void | Promise<void>,
  ): Promise<WebSearchResponse>;
}
