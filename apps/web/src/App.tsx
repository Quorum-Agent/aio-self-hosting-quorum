import {
  Braces,
  ChevronDown,
  FileSearch,
  Image,
  Menu,
  PanelRight,
  Search,
  Shield,
  Sparkles,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ChatMessage,
  ExecutionTrace,
  PolicyMode,
  TaskPlan,
} from "@quorum/core";

import { Composer } from "./components/Composer";
import { ExecutionPanel } from "./components/ExecutionPanel";
import { Sidebar } from "./components/Sidebar";
import {
  getConversations,
  getMessages,
  getRuntime,
  streamChat,
  type ConversationRecord,
  type RuntimeInfo,
} from "./lib/api";

const STARTERS = [
  {
    icon: FileSearch,
    title: "Analyze a document",
    prompt: "Summarize a document locally and identify its key decisions.",
  },
  {
    icon: Braces,
    title: "Work with code",
    prompt: "Help me design a small TypeScript service with clear boundaries.",
  },
  {
    icon: Search,
    title: "Research a topic",
    prompt: "Research the latest developments and explain which steps require the web.",
  },
  {
    icon: Image,
    title: "Inspect an image",
    prompt: "Describe how you would inspect an image using local vision tools.",
  },
];

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
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationId, setConversationId] = useState<string>(createConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingContent, setStreamingContent] = useState("");
  const [policy, setPolicy] = useState<PolicyMode>("balanced");
  const [plan, setPlan] = useState<TaskPlan>();
  const [traces, setTraces] = useState<ExecutionTrace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [executionOpen, setExecutionOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortController = useRef<AbortController | undefined>(undefined);

  const refreshConversations = useCallback(async () => {
    setConversations(await getConversations());
  }, []);

  useEffect(() => {
    void Promise.all([getRuntime(), getConversations()])
      .then(([runtimeInfo, savedConversations]) => {
        setRuntime(runtimeInfo);
        setConversations(savedConversations);
        const first = savedConversations[0];
        if (first) {
          setConversationId(first.id);
          return getMessages(first.id).then(setMessages);
        }
        return undefined;
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Could not connect to Quorum.");
      });
  }, []);

  const activePolicy = useMemo(
    () => runtime?.policies.find((candidate) => candidate.id === policy),
    [policy, runtime],
  );

  const selectConversation = async (id: string) => {
    if (busy) return;
    setConversationId(id);
    setMessages(await getMessages(id));
    setStreamingContent("");
    setPlan(undefined);
    setTraces([]);
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
    setError(undefined);
    setSidebarOpen(false);
  };

  const send = async (prompt = draft) => {
    const content = prompt.trim();
    if (!content || busy) return;

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
    setError(undefined);
    setBusy(true);
    setExecutionOpen(true);

    try {
      await streamChat(
        { conversationId, messages: nextMessages, policy },
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
          } else if (event.type === "error") {
            setError(event.message);
          }
        },
        controller.signal,
      );
      await refreshConversations();
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "The request failed.");
      }
    } finally {
      setBusy(false);
      abortController.current = undefined;
    }
  };

  return (
    <div
      className={`app-shell ${executionOpen ? "execution-visible" : ""} ${
        sidebarOpen ? "sidebar-visible" : ""
      }`}
    >
      <Sidebar
        conversations={conversations}
        activeId={conversationId}
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
          >
            <Menu size={19} />
          </button>

          <div className="model-status">
            <span className={`status-dot ${runtime?.localEndpointConnected ? "is-online" : ""}`} />
            <div>
              <strong>
                {runtime?.localEndpointConnected ? "Local model ready" : "Local scaffold ready"}
              </strong>
              <span>
                {runtime?.localEndpointConnected ? "OpenAI-compatible" : "Connect Ollama anytime"}
              </span>
            </div>
          </div>

          <div className="topbar-actions">
            <label className="policy-select">
              {policy === "offline" ? <WifiOff size={15} /> : <Shield size={15} />}
              <select
                value={policy}
                aria-label="Execution policy"
                onChange={(event) => setPolicy(event.target.value as PolicyMode)}
              >
                {(runtime?.policies ?? []).map((definition) => (
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
            >
              <PanelRight size={16} />
              Inspect
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
              <div className="starter-grid">
                {STARTERS.map((starter) => (
                  <button
                    key={starter.title}
                    type="button"
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
                <article className={`message message-${message.role}`} key={message.id}>
                  <div className="message-avatar">
                    {message.role === "user" ? "You" : <Sparkles size={15} />}
                  </div>
                  <div>
                    <span>{message.role === "user" ? "You" : "Quorum"}</span>
                    <p>{message.content}</p>
                  </div>
                </article>
              ))}
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
              {error && <div className="error-banner">{error}</div>}
            </div>
          )}
        </section>

        <Composer
          value={draft}
          busy={busy}
          onChange={setDraft}
          onSend={() => void send()}
          onStop={() => abortController.current?.abort()}
        />
      </main>

      <ExecutionPanel
        open={executionOpen}
        policy={activePolicy}
        models={runtime?.models ?? []}
        plan={plan}
        traces={traces}
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
