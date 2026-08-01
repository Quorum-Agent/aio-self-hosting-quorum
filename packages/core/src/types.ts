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
 * `web` is the public internet reached by a TOOL, and it is deliberately not
 * `cloud`. In this codebase `cloud` means a vendor's inference API — it
 * receives the entire conversation under that vendor's retention terms. A
 * search provider receives a query string and returns public content. Calling
 * both "cloud" borrowed a connotation that does not apply, and it made a
 * search provider look like a model vendor in every ceiling, log line and
 * disclosure.
 *
 * It sits BELOW `cloud` for that reason: what travels is smaller. A ceiling of
 * `web` is the precise statement "tools may reach the internet, models may
 * not", which no arrangement of the previous vocabulary could express.
 *
 * The order is meaningful. `EXECUTION_LOCATIONS` below is the ordering, and
 * policies express what they permit as a ceiling within it.
 */
export type ExecutionLocation =
  | "device"
  | "local"
  | "network"
  | "remote"
  | "web"
  | "cloud";

/** Ordered nearest-to-furthest. Index is the tier; compare, do not equate. */
export const EXECUTION_LOCATIONS = [
  "device",
  "local",
  "network",
  "remote",
  "web",
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
 * Where Quorum's web-search tool runs.
 *
 * `web` rather than `cloud` deliberately: `cloud` means a vendor's *inference*
 * API, which receives the whole conversation; a search provider receives a
 * query string. The long note at the descriptor site in
 * `apps/api/src/web-search-provider.ts` is the argument; this is the value it
 * argues for, so that copy describing what a policy can search reads the same
 * constant the descriptor does.
 */
export const WEB_SEARCH_LOCATION = "web" as const satisfies ExecutionLocation;

/**
 * Whether a policy permits a tool that runs at `toolLocation`.
 *
 * The single answer to that question. It was written inline at three sites —
 * the orchestrator's retrieval gate, the model-facing tool inventory, and (as
 * `toolCeiling === "none"`) the settings copy naming which policies never
 * search. The first two agreed; the third asked a *different* question and got
 * the same answer only because web search is currently the one tool. A policy
 * with `toolCeiling: "network"` runs no web search either, and the copy would
 * have quietly left it off the list.
 *
 * `"none"` is not a tier and cannot be compared, so it is answered first.
 */
export function policyPermitsTool(
  policy: { toolCeiling: ExecutionLocation | "none" },
  toolLocation: ExecutionLocation,
): boolean {
  if (policy.toolCeiling === "none") return false;
  return locationTier(toolLocation) <= locationTier(policy.toolCeiling);
}

/**
 * Whether anything a policy permits can put content off the device — on either
 * axis.
 *
 * Both ceilings, because a policy that keeps every model on the device and
 * still lets a search tool reach the internet does put content off it. Asking
 * only about inference would answer "no" for exactly that policy.
 */
export function policyReachesOffDevice(policy: {
  inferenceCeiling: ExecutionLocation;
  toolCeiling: ExecutionLocation | "none";
}): boolean {
  return (
    leavesDevice(policy.inferenceCeiling) ||
    (policy.toolCeiling !== "none" && leavesDevice(policy.toolCeiling))
  );
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
  location: Exclude<ExecutionLocation, "device" | "web">;
  transport: "in_process" | "loopback" | "remote";
}): ExecutionLocation {
  // `in_process` only downgrades a model that ALSO declares itself local.
  //
  // The two fields can disagree, and the first version of this trusted
  // transport unconditionally. A descriptor claiming `location: "cloud"` with
  // `transport: "in_process"` then reported tier `device` and passed every
  // ceiling — verified: it was selected under both `private` and `offline`,
  // which the previous boolean check refused. Where the fields contradict each
  // other the safe reading is the further of the two, so this can only ever
  // return the declared location or something nearer, and only when the
  // declaration agrees with it.
  return model.transport === "in_process" && model.location === "local"
    ? "device"
    : model.location;
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

/**
 * Token counts for one model call.
 *
 * `measured` is the load-bearing field. A provider that reports nothing is not
 * a provider that spent nothing, and treating it as zero is how a spend cap
 * develops a silent hole: the one backend that stays quiet becomes the one
 * with no limit. When counts are unavailable these are conservative estimates
 * from character length, and any surface that shows cost must say which it is
 * looking at rather than presenting both as fact.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  measured: boolean;
}

/*
 * No estimator lives here. `estimateInputTokens` in
 * `apps/api/src/openai-compatible-provider.ts` already does this job, and does
 * it better than a second implementation would: it charges the greater of
 * character length and UTF-8 byte length, so multi-byte text is not
 * under-counted, and it is already covered by a test asserting an emoji costs
 * more than an ASCII character. A draft of this file added a rival estimator
 * with a laxer divisor — exactly the "one fact, two implementations" shape
 * this repository keeps finding. Reuse that one.
 */

export interface ModelDescriptor {
  id: Id;
  label: string;
  provider: string;
  role?: LocalModelRole;
  /**
   * `web` is excluded as well as `device`: a model runs somewhere specific —
   * this machine, your network, a box you rent, a vendor — and "the public
   * internet" is not a place a model runs. That tier belongs to tools.
   */
  location: Exclude<ExecutionLocation, "device" | "web">;
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
  /**
   * Which of this model's capabilities the runtime decided, and which are
   * still what a configuration file asserts.
   *
   * A split rather than a flag, and the first version got that wrong. It
   * carried `capabilitiesVerified: boolean`, which meant "the probe replied" —
   * but a probe only ever decides `vision` and `tools`. A model could be marked
   * verified while `reasoning` and `coding` remained unexamined assertions, so
   * the flag read as a blessing over a list nobody had checked. An external
   * reviewer named it as the same silence the field was added to remove.
   *
   * `asserted` is the operational warning: those capabilities are eligibility
   * filters the planner trusts, and nothing has confirmed them. An asserted
   * `vision` routes an image to a model that cannot see it, failing at
   * generation rather than at planning.
   */
  capabilityProvenance: {
    /** Decided by the runtime, which was asked and answered. */
    confirmed: Capability[];
    /** From configuration. Trusted by the planner, verified by nothing. */
    asserted: Capability[];
  };
}

/**
 * Why the local runtime is not serving, when something already knows.
 *
 * The managed llama.cpp runtime produces an exact cause — the readiness loop
 * catches `llama-server` exiting and holds its log tail, which for a rejected
 * artifact reads *"error loading model hyperparameters: key
 * qwen35.rope.dimension_sections has wrong array length; expected 4, got 3"*.
 * That cause was written to the server console and nowhere else, so the
 * interface said "unavailable" and offered the operator a list of five things
 * to check while the runtime already knew which one it was.
 *
 * `summary` is the one sentence an operator can act on. `detail` is the
 * runtime's own words, kept verbatim rather than pattern-matched into a
 * friendlier message: parsing another project's log output to decide what to
 * say is a guess that breaks silently on their next release, and the raw line
 * is more use to whoever has to fix it.
 */
export interface LocalRuntimeProblem {
  summary: string;
  detail?: string;
}

/**
 * A model whose capabilities the runtime decided, against what config declared.
 *
 * Recorded rather than silently applied. Capabilities are hard eligibility
 * filters, so an adjustment changes which requests a model can answer — a
 * removal can make a request dead-end in the scaffold responder, and an
 * addition can put a model on a route it has never served before. Either is a
 * change to routing that the operator did not make, and finding out by
 * observing different behaviour is the failure mode this repository keeps
 * finding: the system holds the fact, the interface does not carry it.
 *
 * Both directions are kept separately because they mean opposite things. An
 * addition is a capability the operator has and could not use. A removal is a
 * claim config was making that the model cannot honour.
 */
export interface CapabilityAdjustment {
  /** The model's label, as the operator configured it. */
  model: string;
  added: Capability[];
  removed: Capability[];
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
  problem?: LocalRuntimeProblem;
  /**
   * Models whose capabilities the runtime decided rather than config.
   *
   * Empty is the normal case and is not reported; entries here mean routing
   * differs from what the configuration file says, and the operator is entitled
   * to know that without reading logs.
   */
  capabilityAdjustments?: CapabilityAdjustment[];
}

export interface PolicyDefinition {
  id: PolicyMode;
  label: string;
  /**
   * What the mode is *for*, hand-written, making no claim about reach.
   *
   * Split out from `description` because reach claims written by hand invert
   * silently — see `policy-copy.ts` for the three that did.
   */
  intent: string;
  /**
   * The user-visible sentence: `intent`, then a reach statement **computed
   * from the two ceilings below**. Never write this by hand; `policies.ts`
   * builds every one of them through `policyDescription`, and its test fails
   * if any policy carries a literal.
   */
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
  /**
   * Where this analyzer runs.
   *
   * The analyzer receives the **full message list**, so it is a
   * conversation-bearing stage exactly as a model step is — but its plan step
   * hardcoded `location: "local"` and nothing tied that literal to reality.
   * It happens to be true today because `config.ts` puts the analyzer's base
   * URL through `normalizeLoopbackBaseUrl`, so the guarantee lived one layer
   * above the place that asserted it.
   *
   * Optional so an analyzer that genuinely is in-process need not restate it;
   * the orchestrator treats an absent value as `"local"`, which is what the
   * hardcoded literal meant.
   */
  readonly location?: Exclude<ExecutionLocation, "device">;
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
