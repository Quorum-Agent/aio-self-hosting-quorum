import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ChatMessage, MessageExecutionRecord } from "@quorum/core";

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  role: ChatMessage["role"];
  content: string;
  created_at: string;
  execution_json: string | null;
}

interface TableInfoRow {
  name: string;
}

function mapConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseExecution(value: string | null): MessageExecutionRecord | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as MessageExecutionRecord;
  } catch {
    return undefined;
  }
}

export class QuorumDatabase {
  readonly #database: DatabaseSync;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.#database = new DatabaseSync(join(dataDirectory, "quorum.db"));
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages(conversation_id, created_at);
    `);
    const messageColumns = this.#database
      .prepare("PRAGMA table_info(messages)")
      .all() as unknown as TableInfoRow[];
    if (!messageColumns.some((column) => column.name === "execution_json")) {
      this.#database.exec("ALTER TABLE messages ADD COLUMN execution_json TEXT");
    }
  }

  close(): void {
    this.#database.close();
  }

  listConversations(): ConversationRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT id, title, created_at, updated_at
         FROM conversations
         ORDER BY updated_at DESC`,
      )
      .all() as unknown as ConversationRow[];
    return rows.map(mapConversation);
  }

  getConversation(id: string): ConversationRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, title, created_at, updated_at
         FROM conversations
         WHERE id = ?`,
      )
      .get(id) as unknown as ConversationRow | undefined;
    return row ? mapConversation(row) : undefined;
  }

  createConversation(id: string, title: string): ConversationRecord {
    const timestamp = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, title, timestamp, timestamp);
    return { id, title, createdAt: timestamp, updatedAt: timestamp };
  }

  listMessages(conversationId: string): ChatMessage[] {
    const rows = this.#database
      .prepare(
        `SELECT id, role, content, created_at, execution_json
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as unknown as MessageRow[];

    return rows.map((row) => {
      const execution = parseExecution(row.execution_json);
      return {
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        ...(execution ? { execution } : {}),
      };
    });
  }

  saveMessage(conversationId: string, message: ChatMessage): void {
    this.#database.exec("BEGIN");
    try {
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO messages (
             id, conversation_id, role, content, created_at, execution_json
           )
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          conversationId,
          message.role,
          message.content,
          message.createdAt,
          message.execution ? JSON.stringify(message.execution) : null,
        );
      this.#database
        .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), conversationId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
