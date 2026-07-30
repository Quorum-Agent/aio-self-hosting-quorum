import {
  Check,
  ChevronRight,
  Circle,
  Cloud,
  Cpu,
  LoaderCircle,
  Monitor,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";

import type { Ref } from "react";

import type {
  ExecutionTrace,
  ModelDescriptor,
  PolicyDefinition,
  ResponseVerbosity,
  TaskPlan,
} from "@quorum/core";

import {
  describeCloudUsage,
  describeModelAttempts,
  type ModelAttemptView,
} from "../lib/runtime-view";

interface ExecutionPanelProps {
  open: boolean;
  policy: PolicyDefinition | undefined;
  models: ModelDescriptor[];
  plan: TaskPlan | undefined;
  traces: ExecutionTrace[];
  verbosity: ResponseVerbosity;
  onClose: () => void;
  ref?: Ref<HTMLElement>;
}

function StepIcon({ trace }: { trace: ExecutionTrace }) {
  if (trace.status === "completed") return <Check size={13} />;
  if (trace.status === "failed") return <X size={13} />;
  if (trace.status === "running") return <LoaderCircle className="spin" size={13} />;
  return <Circle size={10} />;
}

function AttemptIcon({ attempt }: { attempt: ModelAttemptView }) {
  if (attempt.status === "completed") return <Check size={13} />;
  if (attempt.status === "failed") return <X size={13} />;
  return <LoaderCircle className="spin" size={13} />;
}

export function ExecutionPanel({
  open,
  policy,
  models,
  plan,
  traces,
  verbosity,
  onClose,
  ref,
}: ExecutionPanelProps) {
  const selectedModel = models.find((model) => model.id === plan?.modelId);
  // Under relay a second model drafted, and it may be the remote one. Naming
  // only the answering model would hide the stage that actually received the
  // conversation.
  const draftingModel = models.find(
    (model) => model.id === plan?.spokeModelId,
  );
  const modelRan = (plan?.attempts?.length ?? 0) > 0;
  const cloudUsage = describeCloudUsage(plan, models);
  const modelAttempts = describeModelAttempts(plan, models);
  const inspectedVerbosity = plan?.verbosity ?? verbosity;

  return (
    <aside
      id="execution-panel"
      ref={ref}
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

      {plan?.webSearch && (
        <section className="panel-section web-search-summary">
          <div className="section-title">
            <span>Web search</span>
            <small>{plan.webSearch.provider}</small>
          </div>
          <div className="web-search-query">
            <Search size={13} />
            <span>{plan.webSearch.query}</span>
          </div>
          {(plan.webSearch.attempts?.length ?? 0) > 0 && (
            <ol className="web-attempt-list">
              {plan.webSearch.attempts?.map((attempt, index) => (
                <li
                  className={`is-${attempt.status}`}
                  key={`${attempt.provider}-${index}`}
                >
                  <strong>{attempt.provider}</strong>
                  <span>
                    {attempt.status}
                    {attempt.detail ? ` · ${attempt.detail}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <ol className="web-source-list">
            {plan.webSearch.sources.map((source, index) => (
              <li key={`${source.url}-${index}`}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  [{index + 1}] {source.title}
                </a>
              </li>
            ))}
          </ol>
          <p>
            {plan.webSearch.contextMayHaveLeftDevice
              ? "The search query may have left this device; the answering model route is disclosed separately."
              : "Search stayed on this device."}
          </p>
        </section>
      )}

      <section className="panel-section model-summary">
        <div className="section-title">
          <span>
            {draftingModel
              ? modelRan
                ? "Synthesized by"
                : "Will synthesize"
              : modelRan
                ? "Model used"
                : "Model planned"}
          </span>
          <small>{selectedModel?.location ?? "—"}</small>
        </div>
        <strong>{selectedModel?.label ?? "Waiting for request"}</strong>
        {draftingModel && (
          <span className="model-draft-stage">
            Drafted by {draftingModel.label} · {draftingModel.location}
            {draftingModel.location === "cloud"
              ? " · context left this device"
              : ""}
          </span>
        )}
        <span>
          {selectedModel
            ? [
                selectedModel.provider,
                selectedModel.role ? `${selectedModel.role} role` : undefined,
                selectedModel.inference?.reasoningEffort
                  ? selectedModel.inference.reasoningEffort === "none"
                    ? "structured reasoning disabled"
                    : `reasoning ${selectedModel.inference.reasoningEffort}`
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · ")
            : "Quorum will choose at runtime"}
        </span>
      </section>

      {inspectedVerbosity === "detailed" && (
        <section className="panel-section">
          <div className="section-title">
            <span>Model attempts</span>
            <small>
              {modelAttempts.swaps === 0
                ? "No swaps"
                : `${modelAttempts.swaps} swap${modelAttempts.swaps === 1 ? "" : "s"}`}
            </small>
          </div>
          {modelAttempts.attempts.length === 0 ? (
            <p className="attempt-placeholder">
              Attempt and swap history will appear with the next request.
            </p>
          ) : (
            <ol className="attempt-list">
              {modelAttempts.attempts.map((attempt, index) => (
                <li
                  className={`attempt-item is-${attempt.status}`}
                  key={`${attempt.modelId}-${index}`}
                >
                  <div className="attempt-status">
                    <AttemptIcon attempt={attempt} />
                  </div>
                  <div>
                    <strong>{attempt.label}</strong>
                    <span>
                      {attempt.stage ? `${attempt.stage} · ` : ""}
                      {attempt.route} · {attempt.status}
                      {attempt.contextMayHaveBeenTransmitted
                        ? " · context may have left device"
                        : ""}
                    </span>
                    {attempt.detail && <p>{attempt.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

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
