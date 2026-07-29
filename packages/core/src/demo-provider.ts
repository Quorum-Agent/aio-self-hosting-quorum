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
      "Connect an OpenAI-compatible local endpoint (Ollama is supported) to replace this " +
      "deterministic responder with a real model. The execution panel shows the policy, " +
      "route, and model used for this response.";

    for (const part of response.match(WORD_AND_SPACE_PATTERN) ?? [response]) {
      if (input.signal?.aborted) throw new Error("The request was cancelled.");
      yield part;
    }
  }
}
