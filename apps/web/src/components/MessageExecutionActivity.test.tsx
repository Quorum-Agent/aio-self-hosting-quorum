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
    expect(markup).toContain("Structured reasoning fields");
    expect(markup).toContain("answer channel is displayed");
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

  it("keeps failed fallback activity visible for a standard response", () => {
    const message = historicalMessage("standard");
    if (!message.execution) throw new Error("Expected execution metadata.");
    message.execution.plan.fallbackFromModelId = "local:general:test";
    message.execution.plan.modelId = "local:scaffold";
    message.execution.plan.attempts = [
      {
        modelId: "local:general:test",
        route: "local",
        status: "failed",
        contextMayHaveBeenTransmitted: false,
        detail: "The model returned no Quorum final-answer envelope.",
      },
      {
        modelId: "local:scaffold",
        route: "local",
        status: "completed",
        contextMayHaveBeenTransmitted: false,
      },
    ];

    const markup = renderToStaticMarkup(
      <MessageExecutionActivity
        message={message}
        models={[]}
        defaultExpanded={false}
      />,
    );

    expect(markup).toContain("Completed with fallback");
    expect(markup).toContain("1 model swap");
    expect(markup).toContain("<details class=\"execution-activity\" open=\"\"");
  });

  it("uses the persisted execution outcome when no model attempt began", () => {
    const message = historicalMessage("standard");
    if (!message.execution) throw new Error("Expected execution metadata.");
    message.execution.status = "failed";
    message.execution.plan.attempts = [];

    const markup = renderToStaticMarkup(
      <MessageExecutionActivity
        message={message}
        models={[]}
        defaultExpanded={false}
      />,
    );

    expect(markup).toContain("Failed after 1.5s");
    expect(markup).not.toContain("Worked for");
  });

  it("keeps cloud disclosure visible on a standard historical response", () => {
    const message = historicalMessage("standard");
    if (!message.execution) throw new Error("Expected execution metadata.");
    message.execution.plan.cloudDisclosure =
      "The conversation context required by the selected model left this device.";

    const markup = renderToStaticMarkup(
      <MessageExecutionActivity
        message={message}
        models={[]}
        defaultExpanded={false}
      />,
    );

    expect(markup).toContain("Cloud model used");
    expect(markup).toContain("left this device");
    expect(markup).toContain("<details class=\"execution-activity\" open=\"\"");
  });

  it("labels a cancelled execution as stopped rather than as a fallback", () => {
    const message = historicalMessage("standard");
    if (!message.execution) throw new Error("Expected execution metadata.");
    message.execution.plan.attempts = [
      {
        modelId: "local:coding:test",
        route: "local",
        status: "failed",
        contextMayHaveBeenTransmitted: false,
        detail: "The request was cancelled.",
      },
    ];
    message.execution.status = "cancelled";

    const markup = renderToStaticMarkup(
      <MessageExecutionActivity
        message={message}
        models={[]}
        defaultExpanded={false}
      />,
    );

    expect(markup).toContain("Stopped after 1.5s");
    expect(markup).not.toContain("Completed with fallback");
  });

  it("labels a persisted running record as interrupted after reload", () => {
    const message = historicalMessage("standard");
    if (!message.execution) throw new Error("Expected execution metadata.");
    message.execution.status = "running";
    message.execution.plan.webSearch = {
      provider: "DuckDuckGo",
      query: "interrupted search",
      contextMayHaveLeftDevice: true,
      sources: [],
    };

    const markup = renderToStaticMarkup(
      <MessageExecutionActivity
        message={message}
        models={[]}
        defaultExpanded={false}
      />,
    );

    expect(markup).toContain("Interrupted after 1.5s");
    expect(markup).not.toContain("Working for");
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
      attempts: [
        {
          provider: "Exa",
          status: "failed",
          detail: "Web search returned HTTP 503.",
        },
        {
          provider: "SearXNG",
          status: "completed",
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
    expect(markup).toContain("Exa: failed");
    expect(markup).toContain("SearXNG: completed");
    expect(markup).toContain("search query may have left this device");
  });
});
