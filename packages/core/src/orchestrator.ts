import { randomUUID } from "node:crypto";

import { RequestCompiler } from "./request-compiler.js";
import { RoutePlanner } from "./route-planner.js";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionTrace,
  ModelProvider,
  OrchestrationEvent,
  PlanStep,
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

  constructor(
    providers: ModelProvider[],
    compiler = new RequestCompiler(),
    planner = new RoutePlanner(),
  ) {
    this.#providers = new Map(providers.map((provider) => [provider.model.id, provider]));
    this.#compiler = compiler;
    this.#planner = planner;
  }

  get models() {
    return [...this.#providers.values()].map((provider) => provider.model);
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

    let plan;
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

    const modelStep = plan.steps.find((step) => step.kind === "model");
    const synthesisStep = plan.steps.find((step) => step.kind === "synthesis");
    const provider = this.#providers.get(plan.modelId);

    if (!provider || !modelStep || !synthesisStep) {
      yield {
        type: "error",
        message: "The selected execution provider is not registered.",
        recoverable: true,
      };
      return;
    }

    yield { type: "trace", trace: traceFor(request.id, modelStep, "running") };

    let content = "";
    try {
      for await (const delta of provider.stream({
        messages: request.messages,
        request,
        ...(signal ? { signal } : {}),
      })) {
        content += delta;
        yield { type: "delta", content: delta };
      }
    } catch (error) {
      yield {
        type: "trace",
        trace: traceFor(
          request.id,
          modelStep,
          "failed",
          error instanceof Error ? error.message : "Model execution failed.",
        ),
      };
      yield {
        type: "error",
        message: error instanceof Error ? error.message : "Model execution failed.",
        recoverable: true,
      };
      return;
    }

    yield { type: "trace", trace: traceFor(request.id, modelStep, "completed") };
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
