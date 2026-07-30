import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { MessageExecutionRecord } from "@quorum/core";

import { QuorumDatabase } from "./database.js";

const temporaryDirectories: string[] = [];

function executionRecord(): MessageExecutionRecord {
  return {
    startedAt: 1_000,
    completedAt: 2_500,
    plan: {
      id: "plan-1",
      requestId: "request-1",
      policy: "balanced",
      verbosity: "detailed",
      analysis: {
        source: "local_model",
        intent: "coding",
        confidence: 0.94,
        taskSummary: "Create a dynamic Oracle pivot query.",
      },
      route: "local",
      modelId: "local:coding:test",
      rationale: "Balanced mode selected a local coding specialist.",
      steps: [
        {
          id: "model-step",
          label: "Generate with coding expert",
          kind: "model",
          location: "local",
          modelId: "local:coding:test",
        },
      ],
      attempts: [
        {
          modelId: "local:coding:test",
          route: "local",
          status: "completed",
          contextMayHaveBeenTransmitted: false,
        },
      ],
    },
    traces: [
      {
        id: "trace-1",
        requestId: "request-1",
        stepId: "model-step",
        label: "Generate with coding expert",
        kind: "model",
        location: "local",
        status: "completed",
        modelId: "local:coding:test",
        startedAt: new Date(1_000).toISOString(),
        completedAt: new Date(2_500).toISOString(),
      },
    ],
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("QuorumDatabase", () => {
  it("persists a conversation and its messages", () => {
    const directory = mkdtempSync(join(tmpdir(), "quorum-"));
    temporaryDirectories.push(directory);
    const database = new QuorumDatabase(directory);

    database.createConversation("conversation-1", "Local-first architecture");
    database.saveMessage("conversation-1", {
      id: "message-1",
      role: "user",
      content: "Keep this on my device.",
      createdAt: new Date(0).toISOString(),
    });

    expect(database.listConversations()).toHaveLength(1);
    expect(database.listMessages("conversation-1")[0]?.content).toBe(
      "Keep this on my device.",
    );
    database.close();
  });

  it("persists execution detail with its assistant message", () => {
    const directory = mkdtempSync(join(tmpdir(), "quorum-"));
    temporaryDirectories.push(directory);
    const database = new QuorumDatabase(directory);
    database.createConversation("conversation-1", "Oracle pivot");
    database.saveMessage("conversation-1", {
      id: "message-1",
      role: "assistant",
      content: "Use dynamic SQL with LISTAGG.",
      createdAt: new Date(3_000).toISOString(),
      execution: executionRecord(),
    });
    database.close();

    const reopened = new QuorumDatabase(directory);
    expect(reopened.listMessages("conversation-1")[0]?.execution).toEqual(
      executionRecord(),
    );
    reopened.close();
  });

  it("updates a write-ahead execution message only within its conversation", () => {
    const directory = mkdtempSync(join(tmpdir(), "quorum-"));
    temporaryDirectories.push(directory);
    const database = new QuorumDatabase(directory);
    database.createConversation("conversation-1", "Web research");
    database.saveMessage("conversation-1", {
      id: "message-1",
      role: "assistant",
      content: "Web search started.",
      createdAt: new Date(3_000).toISOString(),
      execution: executionRecord(),
    });

    database.updateMessage("conversation-1", {
      id: "message-1",
      role: "assistant",
      content: "Web research completed.",
      createdAt: new Date(3_000).toISOString(),
      execution: executionRecord(),
    });

    expect(database.listMessages("conversation-1")[0]?.content).toBe(
      "Web research completed.",
    );
    expect(() =>
      database.updateMessage("another-conversation", {
        id: "message-1",
        role: "assistant",
        content: "Must not overwrite.",
        createdAt: new Date(3_000).toISOString(),
      }),
    ).toThrow("not found in this conversation");
    database.close();
  });

  it("migrates an existing message table without losing history", () => {
    const directory = mkdtempSync(join(tmpdir(), "quorum-"));
    temporaryDirectories.push(directory);
    const legacy = new DatabaseSync(join(directory, "quorum.db"));
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO conversations VALUES (
        'conversation-1', 'Existing chat',
        '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'
      );
      INSERT INTO messages VALUES (
        'message-1', 'conversation-1', 'user', 'Existing message',
        '1970-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const database = new QuorumDatabase(directory);
    expect(database.listMessages("conversation-1")).toEqual([
      expect.objectContaining({
        id: "message-1",
        content: "Existing message",
      }),
    ]);
    database.saveMessage("conversation-1", {
      id: "message-2",
      role: "assistant",
      content: "Persisted response",
      createdAt: new Date(1_000).toISOString(),
      execution: executionRecord(),
    });
    expect(database.listMessages("conversation-1")[1]?.execution).toEqual(
      executionRecord(),
    );
    database.close();
  });
});
