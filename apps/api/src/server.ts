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
} from "@quorum/core";
import Fastify from "fastify";
import { z } from "zod";

import type { AppConfig } from "./config.js";
import { buildAuthoritativeContext } from "./conversation-context.js";
import { QuorumDatabase } from "./database.js";
import type { QuorumRuntime } from "./runtime.js";

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

function titleFromMessage(message: ChatMessage): string {
  const oneLine = message.content.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine || "New conversation";
}

function writeEvent(response: NodeJS.WritableStream, event: OrchestrationEvent): void {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function buildServer(config: AppConfig, runtime: QuorumRuntime) {
  const app = Fastify({ logger: { level: config.logLevel } });
  const database = new QuorumDatabase(config.dataDirectory);

  app.addHook("onClose", async () => {
    database.close();
  });

  app.get("/api/health", async () => ({
    status: "ok",
    localRuntime: runtime.localRuntime,
    warmup: runtime.warmupStatus,
    cloudConfigured: runtime.cloudConfigured,
  }));

  app.get("/api/runtime", async () => ({
    policies: exposedPolicies,
    models: runtime.orchestrator.models,
    localRuntime: runtime.localRuntime,
    warmup: runtime.warmupStatus,
    cloudConfigured: runtime.cloudConfigured,
  }));

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

  app.post("/api/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid chat request.",
        issues: parsed.error.issues,
      });
    }

    const body = parsed.data;
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

    try {
      for await (const event of runtime.orchestrator.run(
        { ...body, messages },
        controller.signal,
      )) {
        if (event.type === "trace") {
          executionTraces.set(event.trace.stepId, event.trace);
        }
        if (event.type === "result") {
          const persistedMessage: ChatMessage = {
            ...event.result.message,
            execution: {
              plan: event.result.plan,
              traces: [...executionTraces.values()],
              startedAt: executionStartedAt,
              completedAt: Date.now(),
            },
          };
          database.saveMessage(body.conversationId, persistedMessage);
          writeEvent(reply.raw, {
            ...event,
            result: {
              ...event.result,
              message: persistedMessage,
            },
          });
          continue;
        }
        writeEvent(reply.raw, event);
      }
    } catch (error) {
      writeEvent(reply.raw, {
        type: "error",
        message: error instanceof Error ? error.message : "Unexpected orchestration failure.",
        recoverable: true,
      });
    } finally {
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
