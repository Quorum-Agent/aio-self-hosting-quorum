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
    execution?.status === "failed" ||
    execution?.status === "cancelled" ||
    execution?.plan.degraded === true ||
    execution?.plan.fallbackFromModelId !== undefined ||
    execution?.plan.attempts?.some((attempt) => attempt.status === "failed") ===
      true;
  const hasDurableDisclosure =
    execution?.plan.cloudDisclosure !== undefined ||
    (execution?.plan.safety?.sensitiveDataCategories.length ?? 0) > 0 ||
    execution?.plan.safety?.containsWebGroundedData === true;
  if (
    message.role !== "assistant" ||
    !execution ||
    (execution.plan.verbosity !== "detailed" &&
      !execution.plan.webSearch &&
      !hasDegradedExecution &&
      !hasDurableDisclosure)
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
      {...(execution.status ? { status: execution.status } : {})}
      defaultExpanded={
        defaultExpanded ||
        Boolean(execution.plan.webSearch) ||
        hasDegradedExecution ||
        hasDurableDisclosure
      }
    />
  );
}
