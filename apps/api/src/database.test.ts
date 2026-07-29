import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { QuorumDatabase } from "./database.js";

const temporaryDirectories: string[] = [];

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
});
