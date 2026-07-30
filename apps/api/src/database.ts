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

interface SettingRow {
  value_json: string;
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

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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

  getSetting(key: string): unknown | undefined {
    const row = this.#database
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(key) as unknown as SettingRow | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return undefined;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.#database
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  replaceSettingAndPurgePreviousValue(key: string, value: unknown): void {
    this.#database.exec("PRAGMA secure_delete = ON");
    this.setSetting(key, value);
    this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.#database.exec("VACUUM");
    this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
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

  updateMessage(conversationId: string, message: ChatMessage): void {
    const result = this.#database
      .prepare(
        `UPDATE messages
         SET role = ?, content = ?, created_at = ?, execution_json = ?
         WHERE id = ? AND conversation_id = ?`,
      )
      .run(
        message.role,
        message.content,
        message.createdAt,
        message.execution ? JSON.stringify(message.execution) : null,
        message.id,
        conversationId,
      );
    if (result.changes !== 1) {
      throw new Error("The message to update was not found in this conversation.");
    }
    this.#database
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), conversationId);
  }
}
