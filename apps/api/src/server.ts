import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import fastifyStatic from "@fastify/static";
import {
  POLICIES,
  type ChatMessage,
  type ExecutionTrace,
  type OrchestrationEvent,
  type TaskPlan,
} from "@quorum/core";
import Fastify from "fastify";
import { z } from "zod";

import {
  WEB_SEARCH_PROVIDER_IDS,
  type AppConfig,
} from "./config.js";
import { buildAuthoritativeContext } from "./conversation-context.js";
import { QuorumDatabase } from "./database.js";
import { isLoopbackHostname } from "./outbound-url.js";
import type { QuorumRuntime } from "./runtime.js";
import type { WebSearchSettingsUpdate } from "./web-search-provider.js";

const messageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  createdAt: z.string(),
});

const chatRequestSchema = z.object({
  conversationId: z.string().min(1),
  policy: z.enum(["private", "balanced", "quality", "offline"]),
  verbosity: z.enum(["concise", "standard", "detailed"]).default("standard"),
  messages: z.array(messageSchema).min(1),
});
const exposedPolicies = Object.values(POLICIES).filter(
  (policy) => policy.id !== "cost_controlled",
);
const WEB_SEARCH_SETTING_KEY = "web_search";
const apiKeyUpdateSchema = z
  .object({
    exa: z.string().max(4_096).nullable().optional(),
    perplexity: z.string().max(4_096).nullable().optional(),
    tavily: z.string().max(4_096).nullable().optional(),
    brave: z.string().max(4_096).nullable().optional(),
    firecrawl: z.string().max(4_096).nullable().optional(),
  })
  .strict();
const webSearchSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(WEB_SEARCH_PROVIDER_IDS),
    resultLimit: z.number().int().min(3).max(10),
    searxngBaseUrl: z.string().max(2_048).nullable().optional(),
    apiKeys: apiKeyUpdateSchema.optional(),
  })
  .strict();

function containsLegacyStoredApiKeys(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, "apiKeys")
  );
}

function titleFromMessage(message: ChatMessage): string {
  const oneLine = message.content.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine || "New conversation";
}

// Comfortably inside nginx's 60s default proxy_read_timeout.
const KEEP_ALIVE_INTERVAL_MS = 15_000;

function writeEvent(response: NodeJS.WritableStream, event: OrchestrationEvent): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function buildServer(config: AppConfig, runtime: QuorumRuntime) {
  const app = Fastify({ logger: { level: config.logLevel } });
  const database = new QuorumDatabase(config.dataDirectory);
  const savedWebSearchSettings = database.getSetting(WEB_SEARCH_SETTING_KEY);
  if (savedWebSearchSettings && runtime.webSearchProvider) {
    try {
      runtime.webSearchProvider.configureStored(savedWebSearchSettings);
      const sanitized = runtime.webSearchProvider.storedSettings();
      if (
        JSON.stringify(savedWebSearchSettings) !== JSON.stringify(sanitized)
      ) {
        if (containsLegacyStoredApiKeys(savedWebSearchSettings)) {
          database.replaceSettingAndPurgePreviousValue(
            WEB_SEARCH_SETTING_KEY,
            sanitized,
          );
        } else {
          database.setSetting(WEB_SEARCH_SETTING_KEY, sanitized);
        }
      }
    } catch (error) {
      app.log.warn(
        {
          error:
            error instanceof Error
              ? error.message
              : "Saved web-search settings are invalid.",
        },
        "Ignored invalid saved web-search settings.",
      );
    }
  }

  app.addHook("onClose", async () => {
    database.close();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (!isLoopbackHostname(request.hostname)) {
      return reply.code(403).send({ message: "Untrusted request host." });
    }
    const origin = request.headers.origin;
    if (!origin) return;
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) {
        return reply.code(403).send({ message: "Untrusted request origin." });
      }
    } catch {
      return reply.code(403).send({ message: "Untrusted request origin." });
    }
  });

  app.get("/api/health", async () => ({
    status: "ok",
    localRuntime: runtime.localRuntime,
    warmup: runtime.warmupStatus,
    cloudConfigured: runtime.cloudConfigured,
    webSearch: runtime.webSearch,
  }));

  app.get("/api/runtime", async () => {
    await runtime.refreshLocalModels();
    return {
      policies: exposedPolicies,
      models: runtime.orchestrator.models,
      localRuntime: runtime.localRuntime,
      warmup: runtime.warmupStatus,
      cloudConfigured: runtime.cloudConfigured,
      webSearch: runtime.webSearch,
    };
  });

  app.get("/api/settings/web-search", async (_request, reply) => {
    if (!runtime.webSearchProvider) {
      return reply
        .code(503)
        .send({ message: "Web-search settings are unavailable." });
    }
    return { settings: runtime.webSearchProvider.settings() };
  });

  app.put("/api/settings/web-search", async (request, reply) => {
    if (!runtime.webSearchProvider) {
      return reply
        .code(503)
        .send({ message: "Web-search settings are unavailable." });
    }
    const parsed = webSearchSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid web-search settings.",
        issues: parsed.error.issues,
      });
    }
    try {
      const next = runtime.webSearchProvider.previewUpdate(
        parsed.data as WebSearchSettingsUpdate,
      );
      database.setSetting(WEB_SEARCH_SETTING_KEY, next);
      runtime.webSearchProvider.configureStored(next);
      runtime.webSearchProvider.applySessionApiKeyUpdate(
        (parsed.data as WebSearchSettingsUpdate).apiKeys,
      );
      return { settings: runtime.webSearchProvider.settings() };
    } catch (error) {
      return reply.code(400).send({
        message:
          error instanceof Error
            ? error.message
            : "Could not update web-search settings.",
      });
    }
  });

  app.get("/api/conversations", async () => ({
    conversations: database.listConversations(),
  }));

  app.post("/api/conversations", async (request, reply) => {
    const body = z
      .object({ id: z.string().min(1).optional(), title: z.string().min(1).optional() })
      .parse(request.body ?? {});
    const conversation = database.createConversation(
      body.id ?? randomUUID(),
      body.title ?? "New conversation",
    );
    return reply.code(201).send({ conversation });
  });

  app.get("/api/conversations/:id/messages", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!database.getConversation(id)) {
      return reply.code(404).send({ message: "Conversation not found." });
    }
    return { messages: database.listMessages(id) };
  });

  app.patch("/api/conversations/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const { title } = z
      .object({ title: z.string().trim().min(1).max(160) })
      .parse(request.body);
    const conversation = database.renameConversation(id, title);
    return conversation
      ? { conversation }
      : reply.code(404).send({ message: "Conversation not found." });
  });

  app.delete("/api/conversations/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!database.deleteConversation(id)) {
      return reply.code(404).send({ message: "Conversation not found." });
    }
    return reply.code(204).send();
  });

  app.get("/api/conversations/:id/export", async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    const conversation = database.getConversation(id);
    if (!conversation) {
      return reply.code(404).send({ message: "Conversation not found." });
    }
    const safeName =
      conversation.title.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") ||
      "conversation";
    reply.header(
      "content-disposition",
      `attachment; filename="${safeName.slice(0, 80)}.json"`,
    );
    return {
      exportedAt: new Date().toISOString(),
      conversation,
      messages: database.listMessages(id),
    };
  });

  app.post("/api/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid chat request.",
        issues: parsed.error.issues,
      });
    }

    const body = parsed.data;
    await runtime.refreshLocalModels(true);
    if (runtime.warmupStatus.state === "warming") {
      return reply.code(503).send({
        message:
          "Local models are still warming. Quorum will accept messages when the runtime is ready.",
      });
    }
    const latestUserMessage = [...body.messages]
      .reverse()
      .find((message) => message.role === "user");

    if (!latestUserMessage) {
      return reply.code(400).send({ message: "A user message is required." });
    }

    const existingConversation = database.getConversation(body.conversationId);
    const storedMessages = existingConversation
      ? database.listMessages(body.conversationId)
      : [];
    if (!existingConversation) {
      database.createConversation(body.conversationId, titleFromMessage(latestUserMessage));
    }
    const messages = buildAuthoritativeContext(
      storedMessages,
      latestUserMessage,
    );
    const authoritativeUserMessage = messages.at(-1)!;
    database.saveMessage(body.conversationId, authoritativeUserMessage);

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const controller = new AbortController();
    reply.raw.on("close", () => controller.abort());
    const executionStartedAt = Date.now();
    const executionTraces = new Map<string, ExecutionTrace>();
    let latestPlan: TaskPlan | undefined;
    let streamedContent = "";
    let webAuditMessageId: string | undefined;
    let webAuditCreatedAt: string | undefined;
    const writeIfOpen = (event: OrchestrationEvent) => {
      if (!reply.raw.destroyed) writeEvent(reply.raw, event);
    };
    // A relay turn withholds the whole draft, so the connection can sit idle
    // for two full generations with nothing written. x-accel-buffering stops
    // proxies buffering but not from timing an idle connection out — nginx
    // defaults to 60s — so keep the socket warm with SSE comments, which
    // EventSource ignores.
    const keepAlive = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(": keep-alive\n\n");
    }, KEEP_ALIVE_INTERVAL_MS);
    keepAlive.unref?.();
    const executionMessage = (
      plan: TaskPlan,
      content: string,
      source?: ChatMessage,
      status: NonNullable<ChatMessage["execution"]>["status"] = "completed",
    ): ChatMessage => ({
      id: webAuditMessageId ?? source?.id ?? randomUUID(),
      role: "assistant",
      content,
      createdAt:
        webAuditCreatedAt ?? source?.createdAt ?? new Date().toISOString(),
      ...(source?.provenance ? { provenance: source.provenance } : {}),
      execution: {
        plan,
        traces: [...executionTraces.values()],
        startedAt: executionStartedAt,
        completedAt: Date.now(),
        status,
      },
    });
    const persistExecutionMessage = (message: ChatMessage) => {
      if (webAuditMessageId) {
        database.updateMessage(body.conversationId, message);
      } else {
        database.saveMessage(body.conversationId, message);
      }
    };

    try {
      for await (const event of runtime.orchestrator.run(
        { ...body, messages },
        controller.signal,
      )) {
        if (event.type === "trace") {
          const existing = executionTraces.get(event.trace.stepId);
          executionTraces.set(
            event.trace.stepId,
            existing && event.trace.status !== "running"
              ? { ...event.trace, startedAt: existing.startedAt }
              : event.trace,
          );
        }
        if (event.type === "delta") {
          streamedContent += event.content;
        }
        if (event.type === "plan") {
          latestPlan = event.plan;
          if (
            event.plan.webSearch?.contextMayHaveLeftDevice &&
            !webAuditMessageId
          ) {
            webAuditMessageId = randomUUID();
            webAuditCreatedAt = new Date().toISOString();
            database.saveMessage(
              body.conversationId,
              executionMessage(
                event.plan,
                "",
                undefined,
                "running",
              ),
            );
          } else if (webAuditMessageId) {
            database.updateMessage(
              body.conversationId,
              executionMessage(
                event.plan,
                "",
                undefined,
                "running",
              ),
            );
          }
        }
        if (event.type === "result") {
          latestPlan = event.result.plan;
          const persistedMessage = executionMessage(
            event.result.plan,
            event.result.message.content,
            event.result.message,
          );
          persistExecutionMessage(persistedMessage);
          writeIfOpen({
            ...event,
            result: {
              ...event.result,
              message: persistedMessage,
            },
          });
          continue;
        }
        if (event.type === "error" && event.plan) {
          latestPlan = event.plan;
          const persistedMessage = executionMessage(
            event.plan,
            event.partialContent
              ? `${event.partialContent}\n\n[Generation stopped: ${event.message}]`
              : `Request failed: ${event.message}`,
            undefined,
            controller.signal.aborted ? "cancelled" : "failed",
          );
          persistExecutionMessage(persistedMessage);
          writeIfOpen({
            ...event,
            executionMessage: persistedMessage,
          });
          continue;
        }
        writeIfOpen(event);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected orchestration failure.";
      if (latestPlan) {
        const persistedMessage = executionMessage(
          latestPlan,
          streamedContent
            ? `${streamedContent}\n\n[Generation stopped: ${message}]`
            : `Request failed: ${message}`,
          undefined,
          controller.signal.aborted ? "cancelled" : "failed",
        );
        persistExecutionMessage(persistedMessage);
        writeIfOpen({
          type: "error",
          message,
          recoverable: true,
          plan: latestPlan,
          ...(streamedContent ? { partialContent: streamedContent } : {}),
          executionMessage: persistedMessage,
        });
      } else {
        writeIfOpen({
          type: "error",
          message,
          recoverable: true,
        });
      }
    } finally {
      clearInterval(keepAlive);
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const webRoot = resolve(currentDirectory, "../../web/dist");

  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ message: "API route not found." });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
