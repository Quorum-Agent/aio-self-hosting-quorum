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
import { MarkdownMessage } from "./components/MarkdownMessage";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import {
  deleteConversation,
  exportConversation,
  getConversations,
  getMessages,
  getRuntime,
  renameConversation,
  streamChat,
  type ConversationRecord,
  type RuntimeInfo,
} from "./lib/api";
import { createRandomId } from "./lib/random-id";
import { useModalSurface } from "./lib/use-modal-surface";
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
const POLICY_STORAGE_KEY = "quorum:execution-policy";

function savedVerbosity(): ResponseVerbosity {
  const saved = window.localStorage.getItem(VERBOSITY_STORAGE_KEY);
  return saved === "concise" ||
    saved === "standard" ||
    saved === "detailed"
    ? saved
    : "standard";
}

function savedPolicy(): PolicyMode {
  const saved = window.localStorage.getItem(POLICY_STORAGE_KEY);
  return saved === "private" ||
    saved === "balanced" ||
    saved === "quality" ||
    saved === "offline"
    ? saved
    : "balanced";
}

function createConversationId() {
  return createRandomId();
}

function coalesceTrace(
  traces: ExecutionTrace[],
  incoming: ExecutionTrace,
): ExecutionTrace[] {
  const existingIndex = traces.findIndex((trace) => trace.stepId === incoming.stepId);
  if (existingIndex < 0) return [...traces, incoming];
  return traces.map((trace, index) =>
    index === existingIndex
      ? { ...incoming, startedAt: trace.startedAt }
      : trace,
  );
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationId, setConversationId] = useState<string>(createConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [policy, setPolicy] = useState<PolicyMode>(savedPolicy);
  const [verbosity, setVerbosity] =
    useState<ResponseVerbosity>(savedVerbosity);
  const [plan, setPlan] = useState<TaskPlan>();
  const [traces, setTraces] = useState<ExecutionTrace[]>([]);
  const [busy, setBusy] = useState(false);
  const [activityStartedAt, setActivityStartedAt] = useState<number>();
  const [activityCompletedAt, setActivityCompletedAt] = useState<number>();
  const [activityMessageId, setActivityMessageId] = useState<string>();
  const [activityStatus, setActivityStatus] =
    useState<"running" | "completed" | "failed" | "cancelled">();
  const [error, setError] = useState<string>();
  const [executionOpen, setExecutionOpen] = useState(() =>
    window.matchMedia("(min-width: 841px)").matches,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const executionRef = useRef<HTMLElement>(null);
  // Below this width both drawers cover the conversation instead of sitting
  // beside it, which is what makes them modal and what makes trapping focus
  // correct rather than obstructive.
  const [overlayLayout, setOverlayLayout] = useState(
    () => !window.matchMedia("(min-width: 841px)").matches,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const abortController = useRef<AbortController | undefined>(undefined);
  const streamingContentRef = useRef("");
  const conversationElement = useRef<HTMLElement | null>(null);
  const followOutput = useRef(true);
  const conversationIdRef = useRef(conversationId);
  const requestGenerationRef = useRef(0);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

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
    const query = window.matchMedia("(min-width: 841px)");
    const sync = () => setOverlayLayout(!query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const closeExecution = useCallback(() => setExecutionOpen(false), []);
  useModalSurface({
    open: sidebarOpen,
    surface: sidebarRef,
    onClose: closeSidebar,
    enabled: overlayLayout,
  });
  useModalSurface({
    // The sidebar wins when both are open: it is the one on top.
    open: executionOpen && !sidebarOpen,
    surface: executionRef,
    onClose: closeExecution,
    enabled: overlayLayout,
  });

  useEffect(() => {
    window.localStorage.setItem(POLICY_STORAGE_KEY, policy);
  }, [policy]);

  useEffect(() => {
    const element = conversationElement.current;
    if (!element || !followOutput.current) return;
    element.scrollTop = element.scrollHeight;
  }, [error, messages, streamingContent]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refreshRuntime().catch(() => setRuntimeFailed(true));
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      runtime?.warmup.state === "warming" ? 1_000 : 15_000,
    );
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
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
        runtime?.webSearch,
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
  const networkNotice = !activePolicy
    ? "Checking network policy"
    : !activePolicy.allowNetwork
      ? `${activePolicy.label} keeps network access disabled`
      : runtime?.webSearch?.available
        ? `${activePolicy.label} may search the web automatically when current sources are needed`
        : "Web search is not configured";
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
    try {
      const selectedMessages = await getMessages(id);
      setConversationId(id);
      setMessages(selectedMessages);
      setStreamingContent("");
      setPlan(undefined);
      setTraces([]);
      setActivityStartedAt(undefined);
      setActivityCompletedAt(undefined);
      setActivityMessageId(undefined);
      setActivityStatus(undefined);
      setError(undefined);
      setSidebarOpen(false);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not open that conversation.",
      );
      await refreshConversations().catch(() => setRuntimeFailed(true));
    }
  };

  const newConversation = () => {
    if (busy) return;
    setConversationId(createConversationId());
    setMessages([]);
    setStreamingContent("");
    streamingContentRef.current = "";
    setDraft("");
    setPlan(undefined);
    setTraces([]);
    setActivityStartedAt(undefined);
    setActivityCompletedAt(undefined);
    setActivityMessageId(undefined);
    setActivityStatus(undefined);
    setError(undefined);
    setSidebarOpen(false);
  };

  const send = async (prompt = draft) => {
    const content = prompt.trim();
    if (!content || busy || runtimePreparing) return;

    const userMessage: ChatMessage = {
      id: createRandomId(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, userMessage];
    const controller = new AbortController();
    const requestStartedAt = Date.now();
    const requestGeneration = requestGenerationRef.current + 1;
    requestGenerationRef.current = requestGeneration;
    abortController.current = controller;

    setMessages(nextMessages);
    setDraft("");
    setStreamingContent("");
    streamingContentRef.current = "";
    setPlan(undefined);
    setTraces([]);
    setActivityStartedAt(Date.now());
    setActivityCompletedAt(undefined);
    setActivityMessageId(undefined);
    setActivityStatus("running");
    setError(undefined);
    setBusy(true);
    followOutput.current = true;

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
            streamingContentRef.current += event.content;
            setStreamingContent((current) => current + event.content);
          } else if (event.type === "trace") {
            setTraces((current) => coalesceTrace(current, event.trace));
          } else if (event.type === "plan") {
            setPlan(event.plan);
          } else if (event.type === "result") {
            setMessages((current) => [...current, event.result.message]);
            setStreamingContent("");
            streamingContentRef.current = "";
            setActivityCompletedAt(Date.now());
            setActivityMessageId(event.result.message.id);
            setActivityStatus("completed");
          } else if (event.type === "error") {
            if (event.executionMessage) {
              const executionMessage = event.executionMessage;
              setMessages((current) => [
                ...current,
                executionMessage,
              ]);
              setPlan(executionMessage.execution?.plan ?? event.plan);
              setActivityMessageId(executionMessage.id);
              setActivityStatus(executionMessage.execution?.status ?? "failed");
              setError(undefined);
            } else {
              setActivityStatus(
                controller.signal.aborted ? "cancelled" : "failed",
              );
              setError(event.message);
            }
            setStreamingContent("");
            streamingContentRef.current = "";
            setActivityCompletedAt(Date.now());
          }
        },
        controller.signal,
      );
    } catch (reason) {
      if (controller.signal.aborted) {
        setActivityStatus("cancelled");
        let reconciled = false;
        const reconcile = async (): Promise<boolean> => {
          let persistedMessages: ChatMessage[];
          try {
            persistedMessages = await getMessages(conversationId);
          } catch {
            return false;
          }
          const savedExecution = [...persistedMessages]
            .reverse()
            .find(
              (message) =>
                message.role === "assistant" &&
                message.execution &&
                message.execution.startedAt >= requestStartedAt &&
                message.execution.status !== "running",
            );
          if (
            !savedExecution?.execution ||
            conversationIdRef.current !== conversationId ||
            requestGenerationRef.current !== requestGeneration
          ) {
            return false;
          }
          setMessages(persistedMessages);
          setPlan(savedExecution.execution.plan);
          setTraces(savedExecution.execution.traces);
          setActivityStartedAt(savedExecution.execution.startedAt);
          setActivityCompletedAt(savedExecution.execution.completedAt);
          setActivityMessageId(savedExecution.id);
          setActivityStatus(savedExecution.execution.status ?? "completed");
          setError(undefined);
          setStreamingContent("");
          streamingContentRef.current = "";
          return true;
        };
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
          if (await reconcile()) {
            reconciled = true;
            break;
          }
        }
        if (!reconciled) {
          const partial = streamingContentRef.current;
          setStreamingContent(
            partial
              ? `${partial}\n\n[Stopped locally; saved history is still synchronizing.]`
              : "",
          );
          setError("Stopped. Quorum could not yet confirm the saved execution record.");
          void (async () => {
            for (let attempt = 0; attempt < 118; attempt += 1) {
              await new Promise((resolve) => window.setTimeout(resolve, 500));
              if (
                conversationIdRef.current !== conversationId ||
                requestGenerationRef.current !== requestGeneration
              ) {
                return;
              }
              if (await reconcile()) return;
            }
          })();
        }
      } else {
        setActivityStatus("failed");
        setError(reason instanceof Error ? reason.message : "The request failed.");
        setStreamingContent("");
        streamingContentRef.current = "";
      }
      setActivityCompletedAt(Date.now());
    } finally {
      try {
        await Promise.all([refreshRuntime(), refreshConversations()]);
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
        {...(activityStatus ? { status: activityStatus } : {})}
      />
    ) : null;

  return (
    <div
      className={`app-shell ${executionOpen ? "execution-visible" : ""} ${
        sidebarOpen ? "sidebar-visible" : ""
      }`}
    >
      <Sidebar
        ref={sidebarRef}
        conversations={conversations}
        activeId={conversationId}
        disabled={busy}
        onNew={newConversation}
        onSelect={(id) => void selectConversation(id)}
        onRename={(conversation) => {
          const title = window
            .prompt("Rename conversation", conversation.title)
            ?.trim();
          if (!title || title === conversation.title) return;
          void renameConversation(conversation.id, title)
            .then(refreshConversations)
            .catch((reason) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not rename the conversation.",
              ),
            );
        }}
        onExport={(conversation) => {
          void exportConversation(conversation.id).catch((reason) =>
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not export the conversation.",
            ),
          );
        }}
        onDelete={(conversation) => {
          if (
            !window.confirm(
              `Delete "${conversation.title}" and its local history?`,
            )
          ) {
            return;
          }
          void deleteConversation(conversation.id)
            .then(async () => {
              if (conversation.id === conversationId) newConversation();
              await refreshConversations();
            })
            .catch((reason) =>
              setError(
                reason instanceof Error
                  ? reason.message
                  : "Could not delete the conversation.",
              ),
            );
        }}
        onSettings={() => {
          setSettingsOpen(true);
          setSidebarOpen(false);
        }}
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
            <label className="policy-select" title={activePolicy?.description}>
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
                    {definition.allowNetwork && runtime?.webSearch?.available
                      ? " · web when needed"
                      : ""}
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

        <section
          ref={conversationElement}
          className={`conversation ${messages.length === 0 ? "is-empty" : ""}`}
          onScroll={(event) => {
            const element = event.currentTarget;
            followOutput.current =
              element.scrollHeight -
                element.scrollTop -
                element.clientHeight <
              120;
          }}
        >
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
                  {message.content.trim() && (
                    <article className={`message message-${message.role}`}>
                      <div className="message-avatar">
                        {message.role === "user" ? "You" : <Sparkles size={15} />}
                      </div>
                      <div>
                        <span>{message.role === "user" ? "You" : "Quorum"}</span>
                        <MarkdownMessage content={message.content} />
                      </div>
                    </article>
                  )}
                </div>
              ))}
              {!activityMessageId && detailedActivity}
              {(busy || streamingContent) && (
                <article
                  className="message message-assistant is-streaming"
                  role="status"
                  aria-live="polite"
                  aria-atomic="false"
                >
                  <div className="message-avatar">
                    <Sparkles size={15} />
                  </div>
                  <div>
                    <span>Quorum</span>
                    <div>
                      <MarkdownMessage
                        content={streamingContent || "Generating and validating…"}
                      />
                      <i className="cursor" />
                    </div>
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
          networkNotice={networkNotice}
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
        ref={executionRef}
        onClose={() => setExecutionOpen(false)}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={refreshRuntime}
      />

      {/* Both drawers overlay the conversation below 841px. The scrim is
          display: none above that, where the inspector is a real column. */}
      {(sidebarOpen || executionOpen) && (
        <button
          className="mobile-scrim"
          type="button"
          aria-label={
            sidebarOpen ? "Close navigation" : "Close request inspector"
          }
          onClick={() =>
            sidebarOpen ? setSidebarOpen(false) : setExecutionOpen(false)
          }
        />
      )}
    </div>
  );
}
