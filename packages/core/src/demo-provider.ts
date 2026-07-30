import type { ModelDescriptor, ModelProvider, ModelStreamInput } from "./types.js";

const WORD_AND_SPACE_PATTERN = /\S+\s*/g;

export class DemoProvider implements ModelProvider {
  readonly model: ModelDescriptor = {
    id: "local:scaffold",
    label: "Scaffold responder",
    provider: "quorum",
    location: "local" as const,
    transport: "in_process",
    capabilities: ["chat"],
    contextWindow: 32_000,
    qualityRating: 1,
    available: true,
  };

  async *stream(input: ModelStreamInput): AsyncIterable<string> {
    const intent = input.request.requirements.intent;
    const response =
      `Quorum received this as a ${intent} request and kept the scaffolded execution local. ` +
      "No eligible configured model completed a safe public answer. This can mean that " +
      "a local endpoint is unavailable, its configured model is missing, or a model " +
      "attempt failed validation. The execution details show the actual route and attempts.";

    for (const part of response.match(WORD_AND_SPACE_PATTERN) ?? [response]) {
      if (input.signal?.aborted) throw new Error("The request was cancelled.");
      yield part;
    }
  }
}
