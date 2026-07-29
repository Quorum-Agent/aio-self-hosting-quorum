import {
  AlignLeft,
  Braces,
  BrainCircuit,
  ChevronDown,
  Menu,
  MessageCircle,
  PanelRight,
  Shield,
  Sparkles,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Capability,
  ChatMessage,
  ExecutionTrace,
  PolicyMode,
  ResponseVerbosity,
  TaskPlan,
} from "@quorum/core";

import { Composer } from "./components/Composer";
import { ExecutionActivity } from "./components/ExecutionActivity";
import { ExecutionPanel } from "./components/ExecutionPanel";
import { MessageExecutionActivity } from "./components/MessageExecutionActivity";
import { Sidebar } from "./components/Sidebar";
import {
  getConversations,
  getMessages,
  getRuntime,
  streamChat,
  type ConversationRecord,
  type RuntimeInfo,
} from "./lib/api";
import {
  describeRuntimeStatus,
  selectablePolicies,
  supportsCapability,
} from "./lib/runtime-view";

const STARTERS: Array<{
  capability: Capability;
  icon: typeof MessageCircle;
  title: string;
  prompt: string;
}> = [
  {
    capability: "chat",
    icon: MessageCircle,
    title: "Explore an idea",
    prompt:
      "Compare a modular architecture with a monolith for a local-first assistant, then recommend a practical starting point.",
  },
  {
    capability: "coding",
    icon: Braces,
    title: "Work with code",
    prompt: "Help me design a small TypeScript service with clear boundaries.",
  },
  {
    capability: "reasoning",
    icon: BrainCircuit,
    title: "Solve a problem",
    prompt:
      "A local service handles 120 tasks in 8 minutes at a constant rate. How many tasks can it handle in 30 minutes? Explain the reasoning.",
  },
];

const VERBOSITY_STORAGE_KEY = "quorum:response-verbosity";

function savedVerbosity(): ResponseVerbosity {
  const saved = window.localStorage.getItem(VERBOSITY_STORAGE_KEY);
  return saved === "concise" ||
    saved === "standard" ||
    saved === "detailed"
    ? saved
    : "standard";
}

function createConversationId() {
  return crypto.randomUUID();
}

function coalesceTrace(
  traces: ExecutionTrace[],
  incoming: ExecutionTrace,
): ExecutionTrace[] {
  const existingIndex = traces.findIndex((trace) => trace.stepId === incoming.stepId);
  if (existingIndex < 0) return [...traces, incoming];
  return traces.map((trace, index) => (index === existingIndex ? incoming : trace));
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationId, setConversationId] = useState<string>(createConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [policy, setPolicy] = useState<PolicyMode>("balanced");
  const [verbosity, setVerbosity] =
    useState<ResponseVerbosity>(savedVerbosity);
  const [plan, setPlan] = useState<TaskPlan>();
  const [traces, setTraces] = useState<ExecutionTrace[]>([]);
  const [busy, setBusy] = useState(false);
  const [activityStartedAt, setActivityStartedAt] = useState<number>();
  const [activityCompletedAt, setActivityCompletedAt] = useState<number>();
  const [activityMessageId, setActivityMessageId] = useState<string>();
  const [error, setError] = useState<string>();
  const [executionOpen, setExecutionOpen] = useState(() =>
    window.matchMedia("(min-width: 841px)").matches,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortController = useRef<AbortController | undefined>(undefined);

  const refreshConversations = useCallback(async () => {
    setConversations(await getConversations());
  }, []);

  const refreshRuntime = useCallback(async () => {
    const runtimeInfo = await getRuntime();
    setRuntime(runtimeInfo);
    setRuntimeFailed(false);
  }, []);

  const loadApplication = useCallback(async () => {
    setRuntimeFailed(false);
    setError(undefined);
    try {
      const [runtimeInfo, savedConversations] = await Promise.all([
        getRuntime(),
        getConversations(),
      ]);
      setRuntime(runtimeInfo);
      setConversations(savedConversations);
      const first = savedConversations[0];
      if (first) {
        setConversationId(first.id);
        setMessages(await getMessages(first.id));
      }
    } catch (reason) {
      setRuntimeFailed(true);
      setError(
        reason instanceof Error ? reason.message : "Could not connect to Quorum.",
      );
    }
  }, []);

  useEffect(() => {
    void loadApplication();
  }, [loadApplication]);

  useEffect(() => {
    window.localStorage.setItem(VERBOSITY_STORAGE_KEY, verbosity);
  }, [verbosity]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRuntime().catch(() => setRuntimeFailed(true));
    }, runtime?.warmup.state === "warming" ? 1_000 : 5_000);
    return () => window.clearInterval(interval);
  }, [refreshRuntime, runtime?.warmup.state]);

  const activePolicy = useMemo(
    () => runtime?.policies.find((candidate) => candidate.id === policy),
    [policy, runtime],
  );
  const inspectedPolicy = useMemo(
    () =>
      runtime?.policies.find(
        (candidate) => candidate.id === (plan?.policy ?? policy),
      ),
    [plan?.policy, policy, runtime],
  );
  const runtimeStatus = useMemo(
    () =>
      describeRuntimeStatus(
        runtime?.localRuntime,
        runtimeFailed,
        runtime?.warmup,
      ),
    [runtime, runtimeFailed],
  );
  const availableStarters = useMemo(
    () =>
      runtime
        ? STARTERS.filter((starter) =>
            supportsCapability(
              runtime.models,
              starter.capability,
              activePolicy,
              "local",
            ),
          )
        : [],
    [activePolicy, runtime],
  );
  const runtimeWarming = runtime?.warmup.state === "warming";
  const runtimePreparing = !runtime || runtimeWarming;
  const latestExecutionMessageId = useMemo(
    () =>
      [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            message.execution?.plan.verbosity === "detailed",
        )?.id,
    [messages],
  );

  const selectConversation = async (id: string) => {
    if (busy) return;
    setConversationId(id);
    setMessages(await getMessages(id));
    setStreamingContent("");
    setPlan(undefined);
    setTraces([]);
    setActivityStartedAt(undefined);
    setActivityCompletedAt(undefined);
    setActivityMessageId(undefined);
    setSidebarOpen(false);
  };

  const newConversation = () => {
    if (busy) return;
    setConversationId(createConversationId());
    setMessages([]);
    setStreamingContent("");
    setDraft("");
    setPlan(undefined);
    setTraces([]);
    setActivityStartedAt(undefined);
    setActivityCompletedAt(undefined);
    setActivityMessageId(undefined);
    setError(undefined);
    setSidebarOpen(false);
  };

  const send = async (prompt = draft) => {
    const content = prompt.trim();
    if (!content || busy || runtimePreparing) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, userMessage];
    const controller = new AbortController();
    abortController.current = controller;

    setMessages(nextMessages);
    setDraft("");
    setStreamingContent("");
    setPlan(undefined);
    setTraces([]);
    setActivityStartedAt(Date.now());
    setActivityCompletedAt(undefined);
    setActivityMessageId(undefined);
    setError(undefined);
    setBusy(true);
    setExecutionOpen(true);

    try {
      await streamChat(
        {
          conversationId,
          messages: nextMessages,
          policy,
          verbosity,
        },
        (event) => {
          if (event.type === "delta") {
            setStreamingContent((current) => current + event.content);
          } else if (event.type === "trace") {
            setTraces((current) => coalesceTrace(current, event.trace));
          } else if (event.type === "plan") {
            setPlan(event.plan);
          } else if (event.type === "result") {
            setMessages((current) => [...current, event.result.message]);
            setStreamingContent("");
            setActivityCompletedAt(Date.now());
            setActivityMessageId(event.result.message.id);
          } else if (event.type === "error") {
            setStreamingContent("");
            setError(event.message);
            setActivityCompletedAt(Date.now());
          }
        },
        controller.signal,
      );
      await refreshConversations();
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "The request failed.");
      }
      setStreamingContent("");
      setActivityCompletedAt(Date.now());
    } finally {
      try {
        await refreshRuntime();
      } catch {
        setRuntimeFailed(true);
      }
      setBusy(false);
      abortController.current = undefined;
    }
  };

  const detailedActivity =
    activityStartedAt !== undefined &&
    (plan?.verbosity ?? verbosity) === "detailed" ? (
      <ExecutionActivity
        key={activityStartedAt}
        plan={plan}
        traces={traces}
        models={runtime?.models ?? []}
        busy={busy}
        startedAt={activityStartedAt}
        completedAt={activityCompletedAt}
      />
    ) : null;

  return (
    <div
      className={`app-shell ${executionOpen ? "execution-visible" : ""} ${
        sidebarOpen ? "sidebar-visible" : ""
      }`}
    >
      <Sidebar
        conversations={conversations}
        activeId={conversationId}
        disabled={busy}
        onNew={newConversation}
        onSelect={(id) => void selectConversation(id)}
      />

      <main className="main">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
          >
            <Menu size={19} />
          </button>

          <div className="model-status" role="status" aria-live="polite">
            <span className={`status-dot is-${runtimeStatus.state}`} />
            <div>
              <strong>{runtimeStatus.title}</strong>
              <span>{runtimeStatus.detail}</span>
            </div>
          </div>

          <div className="topbar-actions">
            <label className="verbosity-select" title="Response detail">
              <AlignLeft size={15} />
              <select
                value={verbosity}
                aria-label="Response detail"
                disabled={busy}
                onChange={(event) =>
                  setVerbosity(event.target.value as ResponseVerbosity)
                }
              >
                <option value="concise">Concise</option>
                <option value="standard">Standard</option>
                <option value="detailed">Detailed</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="policy-select">
              {policy === "offline" ? <WifiOff size={15} /> : <Shield size={15} />}
              <select
                value={policy}
                aria-label="Execution policy"
                disabled={busy}
                onChange={(event) => setPolicy(event.target.value as PolicyMode)}
              >
                {selectablePolicies(runtime?.policies ?? []).map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.label}
                  </option>
                ))}
                {!runtime && <option value="balanced">Balanced</option>}
              </select>
              <ChevronDown size={14} />
            </label>
            <button
              className={`inspector-button ${executionOpen ? "is-active" : ""}`}
              type="button"
              onClick={() => setExecutionOpen((open) => !open)}
              aria-expanded={executionOpen}
              aria-controls="execution-panel"
            >
              <PanelRight size={16} />
              <span>Inspect</span>
            </button>
          </div>
        </header>

        <section className={`conversation ${messages.length === 0 ? "is-empty" : ""}`}>
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-mark">
                <Sparkles size={25} strokeWidth={1.5} />
              </div>
              <span className="eyebrow">Local-first by design</span>
              <h1>Your models. Your data.<br />One coherent assistant.</h1>
              <p>
                Quorum chooses the best local path first, shows its work, and only
                reaches for the cloud when your policy allows it.
              </p>
              {error && (
                <div className="error-banner" role="alert">
                  {error}
                </div>
              )}
              {runtimeFailed && (
                <button
                  className="retry-button"
                  type="button"
                  onClick={() => void loadApplication()}
                >
                  Retry connection
                </button>
              )}
              <div className="starter-grid">
                {availableStarters.map((starter) => (
                  <button
                    key={starter.title}
                    type="button"
                    disabled={runtimePreparing}
                    onClick={() => void send(starter.prompt)}
                  >
                    <starter.icon size={18} />
                    <span>
                      <strong>{starter.title}</strong>
                      <small>{starter.prompt}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <div className="message-entry" key={message.id}>
                  <MessageExecutionActivity
                    message={message}
                    models={runtime?.models ?? []}
                    defaultExpanded={message.id === latestExecutionMessageId}
                  />
                  <article className={`message message-${message.role}`}>
                    <div className="message-avatar">
                      {message.role === "user" ? "You" : <Sparkles size={15} />}
                    </div>
                    <div>
                      <span>{message.role === "user" ? "You" : "Quorum"}</span>
                      <p>{message.content}</p>
                    </div>
                  </article>
                </div>
              ))}
              {!activityMessageId && detailedActivity}
              {streamingContent && (
                <article className="message message-assistant is-streaming">
                  <div className="message-avatar">
                    <Sparkles size={15} />
                  </div>
                  <div>
                    <span>Quorum</span>
                    <p>{streamingContent}<i className="cursor" /></p>
                  </div>
                </article>
              )}
              {error && (
                <div className="error-banner" role="alert">
                  {error}
                </div>
              )}
            </div>
          )}
        </section>

        <Composer
          value={draft}
          busy={busy}
          disabled={runtimePreparing}
          disabledReason={
            runtime
              ? "Warming local models…"
              : "Connecting to Quorum…"
          }
          onChange={setDraft}
          onSend={() => void send()}
          onStop={() => abortController.current?.abort()}
        />
      </main>

      <ExecutionPanel
        open={executionOpen}
        policy={inspectedPolicy}
        models={runtime?.models ?? []}
        plan={plan}
        traces={traces}
        verbosity={verbosity}
        onClose={() => setExecutionOpen(false)}
      />

      {sidebarOpen && (
        <button
          className="mobile-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
}
