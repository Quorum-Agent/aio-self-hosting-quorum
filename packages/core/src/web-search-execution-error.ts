import type { WebSearchAttempt } from "./types.js";

export class WebSearchExecutionError extends Error {
  readonly attempts: WebSearchAttempt[];

  constructor(message: string, attempts: WebSearchAttempt[]) {
    super(message);
    this.name = "WebSearchExecutionError";
    this.attempts = attempts.map((attempt) => ({ ...attempt }));
  }
}
