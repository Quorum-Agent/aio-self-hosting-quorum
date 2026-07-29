import {
  Check,
  ChevronRight,
  Circle,
  Cloud,
  Cpu,
  LoaderCircle,
  Monitor,
  ShieldCheck,
  X,
} from "lucide-react";

import type {
  ExecutionTrace,
  ModelDescriptor,
  PolicyDefinition,
  TaskPlan,
} from "@quorum/core";

import { describeCloudUsage } from "../lib/runtime-view";

interface ExecutionPanelProps {
  open: boolean;
  policy: PolicyDefinition | undefined;
  models: ModelDescriptor[];
  plan: TaskPlan | undefined;
  traces: ExecutionTrace[];
  onClose: () => void;
}

function StepIcon({ trace }: { trace: ExecutionTrace }) {
  if (trace.status === "completed") return <Check size={13} />;
  if (trace.status === "failed") return <X size={13} />;
  if (trace.status === "running") return <LoaderCircle className="spin" size={13} />;
  return <Circle size={10} />;
}

export function ExecutionPanel({
  open,
  policy,
  models,
  plan,
  traces,
  onClose,
}: ExecutionPanelProps) {
  const selectedModel = models.find((model) => model.id === plan?.modelId);
  const cloudUsage = describeCloudUsage(plan, models);

  return (
    <aside
      id="execution-panel"
      className={`execution-panel ${open ? "is-open" : ""}`}
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Request inspector</span>
          <h2>Execution</h2>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close panel">
          <X size={17} />
        </button>
      </div>

      <section className="policy-card">
        <div className="card-icon">
          <ShieldCheck size={17} />
        </div>
        <div>
          <span>Active policy</span>
          <strong>{policy?.label ?? "Balanced"}</strong>
          <p>{policy?.description}</p>
        </div>
      </section>

      <section className="panel-section">
        <div className="section-title">
          <span>Task graph</span>
          {plan && <small>{plan.route} route</small>}
        </div>

        {traces.length === 0 ? (
          <div className="trace-placeholder">
            <div className="trace-line" />
            <p>Send a message to see how Quorum compiles and routes it.</p>
          </div>
        ) : (
          <ol className="trace-list">
            {traces.map((trace) => (
              <li
                className={`trace-item is-${trace.status}`}
                key={trace.stepId}
                aria-label={`${trace.label}: ${trace.status}`}
              >
                <div className="trace-status">
                  <StepIcon trace={trace} />
                </div>
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
        )}
      </section>

      <section className="panel-section">
        <div className="section-title">
          <span>Route</span>
        </div>
        {plan && (
          <div className="route-row">
            <div className="route-node">
              <Monitor size={15} />
              Device
            </div>
            <ChevronRight size={14} />
            <div className={`route-node ${cloudUsage.selected ? "" : "is-selected"}`}>
              <Cpu size={15} />
              Local
            </div>
            {cloudUsage.selected && (
              <>
                <ChevronRight size={14} />
                <div className="route-node is-selected is-cloud">
                  <Cloud size={15} />
                  Cloud
                </div>
              </>
            )}
          </div>
        )}
        <p className="route-rationale" aria-live="polite">
          {plan?.rationale ?? "No route has been selected yet."}
        </p>
      </section>

      <section className="panel-section model-summary">
        <div className="section-title">
          <span>Model used</span>
          <small>{selectedModel?.location ?? "—"}</small>
        </div>
        <strong>{selectedModel?.label ?? "Waiting for request"}</strong>
        <span>
          {selectedModel
            ? [
                selectedModel.provider,
                selectedModel.role ? `${selectedModel.role} role` : undefined,
                selectedModel.inference?.reasoningEffort
                  ? `reasoning ${selectedModel.inference.reasoningEffort}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · ")
            : "Quorum will choose at runtime"}
        </span>
      </section>

      <div
        className={`cloud-summary ${cloudUsage.activity ? "used-cloud" : ""}`}
        aria-live="polite"
      >
        {cloudUsage.activity ? <Cloud size={15} /> : <ShieldCheck size={15} />}
        <div>
          <strong>Cloud usage</strong>
          <span>
            {cloudUsage.text}
          </span>
        </div>
      </div>
    </aside>
  );
}
