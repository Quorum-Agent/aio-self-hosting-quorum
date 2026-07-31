import {
  Check,
  ChevronDown,
  Circle,
  LoaderCircle,
  Repeat2,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  ExecutionTrace,
  ModelDescriptor,
  TaskPlan,
} from "@quorum/core";

import { describeModelAttempts } from "../lib/runtime-view";

interface ExecutionActivityProps {
  plan: TaskPlan | undefined;
  traces: ExecutionTrace[];
  models: ModelDescriptor[];
  busy: boolean;
  startedAt: number;
  completedAt: number | undefined;
  status?: "running" | "completed" | "failed" | "cancelled";
  defaultExpanded?: boolean;
}

function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function ActivityIcon({ trace }: { trace: ExecutionTrace }) {
  if (trace.status === "completed") return <Check size={12} />;
  if (trace.status === "failed") return <X size={12} />;
  if (trace.status === "running") {
    return <LoaderCircle className="spin" size={12} />;
  }
  return <Circle size={9} />;
}

export function ExecutionActivity({
  plan,
  traces,
  models,
  busy,
  startedAt,
  completedAt,
  status,
  defaultExpanded = true,
}: ExecutionActivityProps) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(defaultExpanded);
  const modelAttempts = useMemo(
    () => describeModelAttempts(plan, models),
    [models, plan],
  );
  const attempts = plan?.attempts ?? [];
  const completedAttempt = attempts.some(
    (attempt) => attempt.status === "completed",
  );
  const failedAttempt = attempts.some((attempt) => attempt.status === "failed");
  const cancelled = status === "cancelled";
  const interrupted = status === "running" && !busy;
  const completedWithFallback =
    completedAttempt &&
    (plan?.fallbackFromModelId !== undefined || failedAttempt);
  const failed =
    status === "failed" || (!completedAttempt && failedAttempt && !cancelled);
  const completionLabel = busy || status === "running"
    ? interrupted
      ? "Interrupted after"
      : "Working for"
    : cancelled
      ? "Stopped after"
      : failed
        ? "Failed after"
        : completedWithFallback
          ? "Completed with fallback after"
          : plan?.degraded
            ? "Completed in degraded mode after"
            : "Worked for";

  useEffect(() => {
    if (!busy) return;
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [busy]);

  const elapsed = (completedAt ?? now) - startedAt;
  const analysis = plan?.analysis;

  return (
    <details
      className="execution-activity"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>
          {completionLabel} {elapsedLabel(elapsed)}
        </span>
        <ChevronDown size={14} />
      </summary>

      <div className="activity-body">
        {analysis && (
          <div className="activity-analysis">
            <strong>
              {analysis.source === "hybrid"
                ? "Hybrid classification guard"
                : analysis.analyzer?.modelLabel ?? "Deterministic compiler"}{" "}
              · {analysis.intent}
            </strong>
            <span>
              {analysis.source === "hybrid" && analysis.analyzer
                ? `${analysis.analyzer.modelLabel} proposed ${analysis.analyzer.intent}`
                : `${Math.round(analysis.confidence * 100)}% confidence`}
            </span>
            <p>{analysis.taskSummary}</p>
          </div>
        )}

        <ol className="activity-traces">
          {traces.map((trace) => (
            <li className={`is-${trace.status}`} key={trace.stepId}>
              <i>
                <ActivityIcon trace={trace} />
              </i>
              <div>
                <strong>{trace.label}</strong>
                <span>
                  {trace.location}
                  {trace.detail ? ` · ${trace.detail}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ol>

        {plan && (
          <div className="activity-route">
            <Repeat2 size={13} />
            <div>
              <strong>
                {!busy && (plan.attempts?.length ?? 0) === 0
                  ? "Model did not run"
                  : modelAttempts.swaps === 0
                  ? "No model swap"
                  : `${modelAttempts.swaps} model swap${modelAttempts.swaps === 1 ? "" : "s"}`}
              </strong>
              <span>{plan.rationale}</span>
            </div>
          </div>
        )}

        {plan?.webSearch && (
          <div className="activity-web-search">
            <Search size={13} />
            <div>
              <strong>Web search via {plan.webSearch.provider}</strong>
              <span>{plan.webSearch.query}</span>
              {(plan.webSearch.attempts?.length ?? 0) > 0 && (
                <ul className="web-attempt-list">
                  {plan.webSearch.attempts?.map((attempt, index) => (
                    <li
                      className={`is-${attempt.status}`}
                      key={`${attempt.provider}-${index}`}
                    >
                      {attempt.provider}: {attempt.status}
                      {attempt.detail ? ` · ${attempt.detail}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              <ol>
                {plan.webSearch.sources.map((source, index) => (
                  <li key={`${source.url}-${index}`}>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      [{index + 1}] {source.title}
                    </a>
                  </li>
                ))}
              </ol>
              {plan.webSearch.contextMayHaveLeftDevice && (
                <small>The search query may have left this device.</small>
              )}
            </div>
          </div>
        )}

        {plan?.cloudDisclosure && (
          <div className="activity-disclosure" role="note">
            {/* Not "Cloud model used": this disclosure is attached at PLAN
                time from `leavesDevice(route)`, so it fires for the network and
                remote tiers too, and it can render beside "Model did not run".
                Past tense and a vendor-specific noun were both wrong. */}
            <strong>Leaves this device</strong>
            <span>{plan.cloudDisclosure}</span>
          </div>
        )}

        {(plan?.safety?.sensitiveDataCategories.length ?? 0) > 0 && (
          <div className="activity-disclosure" role="note">
            <strong>Kept local by privacy guard</strong>
            <span>
              Detected categories:{" "}
              {plan?.safety?.sensitiveDataCategories.join(", ")}
            </span>
          </div>
        )}

        {plan?.safety?.containsWebGroundedData && (
          <div className="activity-disclosure" role="note">
            <strong>Web-grounded history kept local</strong>
            <span>
              Prior retrieved material was not forwarded off this device.
            </span>
          </div>
        )}

        <p className="activity-boundary">
          Shows request analysis and execution events. Structured reasoning fields
          are withheld; text produced in the model's validated answer channel is
          displayed.
        </p>
      </div>
    </details>
  );
}
