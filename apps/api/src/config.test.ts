import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, PROJECT_ROOT } from "./config.js";

const originalDataDirectory = process.env["QUORUM_DATA_DIR"];

afterEach(() => {
  if (originalDataDirectory === undefined) {
    delete process.env["QUORUM_DATA_DIR"];
  } else {
    process.env["QUORUM_DATA_DIR"] = originalDataDirectory;
  }
});

describe("loadConfig", () => {
  it("resolves relative data paths from the repository root", () => {
    process.env["QUORUM_DATA_DIR"] = "./test-data";

    expect(loadConfig().dataDirectory).toBe(resolve(PROJECT_ROOT, "test-data"));
  });
});
