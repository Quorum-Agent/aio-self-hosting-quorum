import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@quorum/core";

import { MessageExecutionActivity } from "./MessageExecutionActivity";

function historicalMessage(verbosity: "standard" | "detailed"): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    content: "Use an Oracle-specific dynamic pivot.",
    createdAt: new Date(3_000).toISOString(),
    execution: {
      startedAt: 1_000,
      completedAt: 2_500,
      plan: {
        id: "plan-1",
        requestId: "request-1",
        policy: "balanced",
        verbosity,
        analysis: {
          source: "local_model",
          intent: "coding",
          confidence: 0.94,
          taskSummary: "Adapt the dynamic pivot query for Oracle.",
        },
        route: "local",
        modelId: "local:coding:test",
        rationale: "Balanced mode selected a local coding specialist.",
        steps: [],
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
    },
  };
}

describe("MessageExecutionActivity", () => {
  it("renders persisted detailed activity for an historical assistant message", () => {
    const markup = renderToStaticMarkup(
      <MessageExecutionActivity
        message={historicalMessage("detailed")}
        models={[]}
        defaultExpanded={false}
      />,
    );

    expect(markup).toContain("Worked for 1.5s");
    expect(markup).toContain("Adapt the dynamic pivot query for Oracle.");
    expect(markup).toContain("Generate with coding expert");
    expect(markup).not.toContain("<details open=");
  });

  it("does not add an in-chat activity view to a standard response", () => {
    expect(
      renderToStaticMarkup(
        <MessageExecutionActivity
          message={historicalMessage("standard")}
          models={[]}
          defaultExpanded={false}
        />,
      ),
    ).toBe("");
  });

  it("keeps web-search sources and egress disclosure in historical activity", () => {
    const message = historicalMessage("standard");
    if (!message.execution) throw new Error("Expected execution metadata.");
    message.execution.plan.webSearch = {
      provider: "SearXNG",
      query: "latest Quorum release",
      contextMayHaveLeftDevice: true,
      sources: [
        {
          title: "Current release",
          url: "https://example.com/release",
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <MessageExecutionActivity
        message={message}
        models={[]}
        defaultExpanded
      />,
    );

    expect(markup).toContain("Web search via SearXNG");
    expect(markup).toContain("latest Quorum release");
    expect(markup).toContain("https://example.com/release");
    expect(markup).toContain("search query may have left this device");
  });
});
