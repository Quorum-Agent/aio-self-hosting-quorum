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
  defaultExpanded = true,
}: ExecutionActivityProps) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(defaultExpanded);
  const modelAttempts = useMemo(
    () => describeModelAttempts(plan, models),
    [models, plan],
  );

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
          {busy ? "Working" : "Worked"} for {elapsedLabel(elapsed)}
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

        <p className="activity-boundary">
          Shows request analysis and execution events. Private model scratch work
          is not exposed.
        </p>
      </div>
    </details>
  );
}
