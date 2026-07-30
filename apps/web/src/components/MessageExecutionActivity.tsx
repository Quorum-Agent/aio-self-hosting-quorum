import type { ChatMessage, ModelDescriptor } from "@quorum/core";

import { ExecutionActivity } from "./ExecutionActivity";

interface MessageExecutionActivityProps {
  message: ChatMessage;
  models: ModelDescriptor[];
  defaultExpanded: boolean;
}

export function MessageExecutionActivity({
  message,
  models,
  defaultExpanded,
}: MessageExecutionActivityProps) {
  const execution = message.execution;
  const hasDegradedExecution =
    execution?.plan.degraded === true ||
    execution?.plan.fallbackFromModelId !== undefined ||
    execution?.plan.attempts?.some((attempt) => attempt.status === "failed") ===
      true;
  if (
    message.role !== "assistant" ||
    !execution ||
    (execution.plan.verbosity !== "detailed" &&
      !execution.plan.webSearch &&
      !hasDegradedExecution)
  ) {
    return null;
  }

  return (
    <ExecutionActivity
      plan={execution.plan}
      traces={execution.traces}
      models={models}
      busy={false}
      startedAt={execution.startedAt}
      completedAt={execution.completedAt}
      defaultExpanded={
        defaultExpanded ||
        Boolean(execution.plan.webSearch) ||
        hasDegradedExecution
      }
    />
  );
}
