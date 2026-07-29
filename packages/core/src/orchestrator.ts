import { randomUUID } from "node:crypto";

import { RequestCompiler } from "./request-compiler.js";
import { RoutePlanner } from "./route-planner.js";
import { ModelExecutionError } from "./model-execution-error.js";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionAttempt,
  ExecutionTrace,
  ModelProvider,
  OrchestrationEvent,
  PlanStep,
  PromptAnalyzer,
  TaskPlan,
} from "./types.js";

function traceFor(
  requestId: string,
  step: PlanStep,
  status: ExecutionTrace["status"],
  detail?: string,
): ExecutionTrace {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    requestId,
    stepId: step.id,
    label: step.label,
    kind: step.kind,
    location: step.location,
    status,
    startedAt: now,
    ...(status === "completed" || status === "failed" ? { completedAt: now } : {}),
    ...(step.modelId ? { modelId: step.modelId } : {}),
    ...(detail ? { detail } : {}),
  };
}

export class Orchestrator {
  readonly #compiler: RequestCompiler;
  readonly #planner: RoutePlanner;
  readonly #providers: Map<string, ModelProvider>;
  readonly #promptAnalyzer: PromptAnalyzer | undefined;
  readonly #failures = new Map<
    string,
    { consecutive: number; unavailableUntil: number }
  >();
  readonly #circuitFailureThreshold = 2;
  readonly #circuitCooldownMs = 30_000;

  constructor(
    providers: ModelProvider[],
    compiler = new RequestCompiler(),
    planner = new RoutePlanner(),
    promptAnalyzer?: PromptAnalyzer,
  ) {
    this.#providers = new Map(providers.map((provider) => [provider.model.id, provider]));
    this.#compiler = compiler;
    this.#planner = planner;
    this.#promptAnalyzer = promptAnalyzer;
  }

  get models() {
    const now = Date.now();
    return [...this.#providers.values()].map((provider) => {
      const failure = this.#failures.get(this.#providerIdentity(provider));
      return failure && failure.unavailableUntil > now
        ? { ...provider.model, available: false }
        : provider.model;
    });
  }

  #providerIdentity(provider: ModelProvider): string {
    return [
      provider.model.location,
      provider.model.provider,
      provider.model.label,
    ].join(":");
  }

  #recordFailure(provider: ModelProvider): void {
    const identity = this.#providerIdentity(provider);
    const previous = this.#failures.get(identity);
    const consecutive = (previous?.consecutive ?? 0) + 1;
    this.#failures.set(identity, {
      consecutive,
      unavailableUntil:
        consecutive >= this.#circuitFailureThreshold
          ? Date.now() + this.#circuitCooldownMs
          : 0,
    });
  }

  #recordSuccess(provider: ModelProvider): void {
    this.#failures.delete(this.#providerIdentity(provider));
  }

  #excludePhysicalProvider(
    provider: ModelProvider,
    excludedModelIds: Set<string>,
  ): void {
    const identity = this.#providerIdentity(provider);
    for (const candidate of this.#providers.values()) {
      if (this.#providerIdentity(candidate) === identity) {
        excludedModelIds.add(candidate.model.id);
      }
    }
  }

  async *run(input: ChatRequest, signal?: AbortSignal): AsyncGenerator<OrchestrationEvent> {
    let request;

    try {
      request = this.#compiler.compile(input);
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : "Request compilation failed.",
        recoverable: true,
      };
      return;
    }

    if (this.#promptAnalyzer && input.policy !== "offline") {
      const analyzerStep: PlanStep = {
        id: randomUUID(),
        label: `Extract request intent with ${this.#promptAnalyzer.label}`,
        kind: "classification",
        location: "local",
        modelId: this.#promptAnalyzer.id,
      };
      yield {
        type: "trace",
        trace: traceFor(request.id, analyzerStep, "running"),
      };
      try {
        const analysis = await this.#promptAnalyzer.analyze(
          {
            messages: request.messages,
            baseline: request.analysis,
            baselineIntentSource: request.requirements.intentSource,
          },
          signal,
        );
        request = this.#compiler.applyPromptAnalysis(
          request,
          this.#promptAnalyzer,
          analysis,
        );
        const analysisDetail =
          request.analysis.source === "hybrid" &&
          request.analysis.analyzer
            ? `${request.analysis.analyzer.intent} proposed · deterministic ${request.analysis.intent} retained`
            : `${request.analysis.intent} · ${Math.round(request.analysis.confidence * 100)}% confidence`;
        yield {
          type: "trace",
          trace: traceFor(
            request.id,
            analyzerStep,
            "completed",
            analysisDetail,
          ),
        };
      } catch (error) {
        yield {
          type: "trace",
          trace: traceFor(
            request.id,
            analyzerStep,
            "failed",
            `${error instanceof Error ? error.message : "Prompt analysis failed."} Deterministic classification retained.`,
          ),
        };
      }
    }

    let plan: TaskPlan;
    try {
      plan = this.#planner.plan(request, this.models);
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : "No execution route is available.",
        recoverable: true,
      };
      return;
    }

    yield { type: "plan", plan };

    for (const step of plan.steps.slice(0, 2)) {
      yield { type: "trace", trace: traceFor(request.id, step, "running") };
      yield { type: "trace", trace: traceFor(request.id, step, "completed") };
    }

    let content = "";
    const excludedModelIds = new Set<string>();
    const attempts: ExecutionAttempt[] = [];

    while (true) {
      const modelStep = plan.steps.find((step) => step.kind === "model");
      const provider = this.#providers.get(plan.modelId);
      if (!provider || !modelStep) {
        yield {
          type: "error",
          message: "The selected execution provider is not registered.",
          recoverable: true,
        };
        return;
      }

      yield { type: "trace", trace: traceFor(request.id, modelStep, "running") };

      let attemptContent = "";
      let executionError: unknown;
      try {
        for await (const delta of provider.stream({
          messages: request.messages,
          request,
          runtimeModels: this.models.map((model) =>
            excludedModelIds.has(model.id)
              ? { ...model, available: false }
              : model,
          ),
          ...(signal ? { signal } : {}),
        })) {
          attemptContent += delta;
          content += delta;
          yield { type: "delta", content: delta };
        }
        if (!attemptContent) {
          throw new Error(`${provider.model.label} returned no response content.`);
        }
      } catch (error) {
        executionError = error;
      }

      if (!executionError) {
        this.#recordSuccess(provider);
        attempts.push({
          modelId: provider.model.id,
          route: provider.model.location,
          status: "completed",
          contextMayHaveBeenTransmitted: provider.model.location === "cloud",
        });
        plan = { ...plan, attempts: [...attempts] };
        yield {
          type: "trace",
          trace: traceFor(request.id, modelStep, "completed"),
        };
        break;
      }

      const failureMessage =
        executionError instanceof Error
          ? executionError.message
          : "Model execution failed.";
      attempts.push({
        modelId: provider.model.id,
        route: provider.model.location,
        status: "failed",
        contextMayHaveBeenTransmitted: provider.model.location === "cloud",
        detail: failureMessage,
      });
      yield {
        type: "trace",
        trace: traceFor(request.id, modelStep, "failed", failureMessage),
      };

      const cancelled =
        signal?.aborted ||
        (executionError instanceof ModelExecutionError &&
          executionError.kind === "cancelled");
      if (
        !cancelled &&
        (!(executionError instanceof ModelExecutionError) ||
          executionError.kind === "provider")
      ) {
        this.#recordFailure(provider);
      }

      if (cancelled || attemptContent) {
        plan = { ...plan, attempts: [...attempts] };
        yield { type: "plan", plan };
        yield {
          type: "error",
          message: cancelled
            ? "The request was cancelled."
            : `${failureMessage} Automatic fallback was stopped because output had already begun.`,
          recoverable: !cancelled,
        };
        return;
      }

      this.#excludePhysicalProvider(provider, excludedModelIds);
      let fallbackPlan: TaskPlan;
      try {
        fallbackPlan = this.#planner.plan(
          request,
          this.models.map((model) =>
            provider.model.location === "local" && model.location === "cloud"
              ? { ...model, available: false }
              : model,
          ),
          excludedModelIds,
        );
      } catch {
        plan = { ...plan, attempts: [...attempts] };
        yield { type: "plan", plan };
        yield {
          type: "error",
          message: `${failureMessage} No safe fallback route is available.`,
          recoverable: true,
        };
        return;
      }

      fallbackPlan = {
        ...fallbackPlan,
        fallbackFromModelId: provider.model.id,
        attempts: [...attempts],
        rationale:
          `${provider.model.label} failed before producing output. ` +
          fallbackPlan.rationale,
      };
      plan = fallbackPlan;
      yield { type: "plan", plan };
    }

    yield { type: "plan", plan };

    const synthesisStep = plan.steps.find((step) => step.kind === "synthesis");
    if (!synthesisStep) {
      yield {
        type: "error",
        message: "The execution plan is missing response synthesis.",
        recoverable: true,
      };
      return;
    }
    yield { type: "trace", trace: traceFor(request.id, synthesisStep, "running") };
    yield { type: "trace", trace: traceFor(request.id, synthesisStep, "completed") };

    const message: ChatMessage = {
      id: randomUUID(),
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    };

    yield {
      type: "result",
      result: {
        requestId: request.id,
        conversationId: request.conversationId,
        message,
        plan,
      },
    };
  }
}
