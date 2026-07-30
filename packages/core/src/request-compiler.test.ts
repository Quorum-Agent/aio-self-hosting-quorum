import { describe, expect, it } from "vitest";

import {
  containsSensitiveContent,
  RequestCompiler,
} from "./request-compiler.js";
import type { ChatMessage, ChatRequest, RequestIntent } from "./types.js";

function request(content: string): ChatRequest {
  return {
    conversationId: "conversation-1",
    policy: "balanced",
    messages: [
      {
        id: "message-1",
        role: "user",
        content,
        createdAt: new Date(0).toISOString(),
      },
    ],
  };
}

function conversationRequest(contents: string[]): ChatRequest {
  return {
    conversationId: "conversation-1",
    policy: "balanced",
    messages: contents.map((content, index) => ({
      id: `message-${index}`,
      role: "user",
      content,
      createdAt: new Date(index).toISOString(),
    })),
  };
}

function assistantWithIntent(
  intent: RequestIntent,
  index: number,
): ChatMessage {
  return {
    id: `assistant-${index}`,
    role: "assistant",
    content: `Previous ${intent} response.`,
    createdAt: new Date(index).toISOString(),
    execution: {
      startedAt: index,
      completedAt: index + 1,
      plan: {
        id: `plan-${index}`,
        requestId: `request-${index}`,
        policy: "balanced",
        verbosity: "detailed",
        analysis: {
          source: "local_model",
          intent,
          confidence: 0.94,
          taskSummary: `Continue the ${intent} task.`,
        },
        route: "local",
        modelId: `local:${intent}:test`,
        rationale: `Selected the ${intent} route.`,
        steps: [],
      },
      traces: [],
    },
  };
}

describe("RequestCompiler", () => {
  const compiler = new RequestCompiler();

  it("does not treat a model capabilities question as fresh web research", () => {
    const compiled = compiler.compile(
      request("What are your current capabilities?"),
    );

    expect(compiled.requirements).toEqual({
      intent: "conversation",
      intentConfidence: 0.5,
      intentSource: "default",
      capabilities: ["chat"],
      requiresFreshness: false,
      containsSensitiveData: false,
      sensitiveDataCategories: [],
      containsWebGroundedData: false,
    });
    expect(compiled.verbosity).toBe("standard");
    expect(compiled.analysis).toEqual({
      source: "heuristic",
      intent: "conversation",
      confidence: 0.5,
      taskSummary: "What are your current capabilities?",
    });
  });

  it("preserves an explicit response verbosity preference", () => {
    expect(
      compiler.compile({
        ...request("Explain the routing decision."),
        verbosity: "detailed",
      }).verbosity,
    ).toBe("detailed");
  });

  it.each([
    "What is the current federal tax law?",
    "Who is currently the CEO?",
    "Give me today's weather.",
    "Research the latest Qwen release.",
  ])("keeps genuinely time-sensitive requests fresh: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.intent).toBe("research");
    expect(compiled.requirements.requiresFreshness).toBe(true);
    expect(compiled.requirements.capabilities).toEqual([
      "chat",
      "reasoning",
      "web",
    ]);
  });

  it.each([
    // The model landscape moves faster than anything else this product routes
    // over, and "model" was absent from the time-sensitive vocabulary, so no
    // phrasing of "which model is best" could ever reach the web.
    "What is the most recent coding model advisor from Qwen?",
    "So qwen3.5:9B is the best spoke publicly available?",
    "What is the best publicly available model?",
    "What is the state of the art open weight model?",
  ])("searches for a present-tense ranking of public options: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.requiresFreshness).toBe(true);
    expect(compiled.requirements.capabilities).toContain("web");
  });

  it.each([
    // A named family is a moving public subject, so a time word is enough.
    "What is the latest from Qwen?",
    "What is the newest Llama available?",
  ])("recognises a named model family as time-sensitive: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.capabilities).toContain("web");
  });

  it.each([
    // A public scope with no ranking is timeless.
    "How does open source licensing work?",
    // A family named without any time signal is ordinary explanation.
    "Explain how Llama attention works.",
    // A ranking with no public scope is not about the outside world.
    "What is the best way to sort this array?",
    "What are the best practices for error handling?",
  ])("leaves a half-signal alone: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.requiresFreshness).toBe(false);
    expect(compiled.requirements.capabilities).not.toContain("web");
  });

  it("still withholds the web from a personal question that reads as fresh", () => {
    // Q-15: the personal-scope block, not the freshness rule, is what keeps
    // this sentence on the device. Widening freshness must not bypass it.
    const compiled = compiler.compile(
      request("What is my current medication schedule?"),
    );

    expect(compiled.requirements.capabilities).not.toContain("web");
  });

  it("treats an explicit citation request as research without inventing freshness", () => {
    const compiled = compiler.compile(
      request("Cite sources supporting this architectural recommendation."),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "research",
      requiresFreshness: false,
      capabilities: ["chat", "reasoning", "web"],
    });
  });

  it.each([
    "Add a source map to the Webpack build.",
    "Add a citations field to this TypeScript interface.",
    "Include the source code file in the package.",
    "Provide a source property on this React component.",
    "Review the latest source code: const internalAlgorithm = 42;",
    "Undo my most recent local commit.",
    "Use the latest value from this array.",
    "Fix the live preview component in this code.",
  ])("does not authorize web search for local coding language: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.intent).toBe("coding");
    expect(compiled.requirements.capabilities).not.toContain("web");
  });

  it.each([
    "List sources from the local database without using the internet.",
    "Do not use the internet. Summarize the Acme merger for me.",
    "Don't search the web. What are the latest news on the merger?",
    "Never access the internet. Explain the current prices.",
    "Research the local database; do not use external services.",
  ])("honors an explicit network denial: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.capabilities).not.toContain("web");
  });

  it.each([
    "Research this offline.",
    "Research only my local notes.",
    "Research the local database; do not use external services.",
    "Research this topic.",
  ])("does not treat research intent alone as network consent: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.intent).toBe("research");
    expect(compiled.requirements.capabilities).toEqual(["chat", "reasoning"]);
  });

  it("authorizes web capability when the user explicitly asks for web search", () => {
    expect(
      compiler.compile(request("Search the web for Quorum architecture sources."))
        .requirements.capabilities,
    ).toEqual(["chat", "reasoning", "web"]);
  });

  it("recognizes explicit external-web phrasing as research authorization", () => {
    const compiled = compiler.compile(
      request("Use external web sources to compare these claims."),
    );

    expect(compiled.requirements.intent).toBe("research");
    expect(compiled.requirements.capabilities).toContain("web");
  });

  it.each([
    "Now summarize that offline.",
    "Now compare it using only my local notes.",
    "What about it without external services?",
  ])("lets a current follow-up denial override prior web authorization: %s", (prompt) => {
    const compiled = compiler.compile(
      conversationRequest([
        "Search the web for the latest Quorum release.",
        prompt,
      ]),
    );

    expect(compiled.requirements.intent).toBe("research");
    expect(compiled.requirements.capabilities).not.toContain("web");
  });

  it.each([
    "Solve this equation: 2x + 4 = 12.",
    "Analyze the logic of this argument.",
    "Calculate the area of a circle with radius 5.",
    "Compare a modular architecture with a monolith for a local-first assistant, then recommend a practical starting point.",
  ])("classifies explicit reasoning work: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.intent).toBe("reasoning");
    expect(compiled.requirements.capabilities).toEqual([
      "chat",
      "reasoning",
    ]);
    expect(compiled.requirements.requiresFreshness).toBe(false);
  });

  it.each([
    "Write a SQL query to list overdue invoices.",
    "Refactor this Go method to avoid duplication.",
    "Solve this SQL query.",
    "Analyze the runtime complexity of this algorithm.",
    "Thank you. Could this be used easily with JS applications?",
    "Can I call this from a TS service?",
    "Integrate this with NodeJS.",
    "Would JQuery be any different?",
    "Migrate this Angular component to Vue.js.",
    "Run the suite with pytest.",
    "Containerize the service with Docker.",
    "Change the PostgreSQL schema.",
    "Update package.json and tsconfig.json.",
    "Add a route to this Express app.",
    "Configure the Spring Boot service.",
    "Write an HCL module for Terraform.",
    "How should I structure React state?",
    "Why does my Android Activity crash?",
    "Explain this HTTP 500 from the API.",
    "Update this Helm chart.",
    "Optimize this CUDA kernel.",
    "Validate this YAML config.",
    "Fix this regular expression.",
    "Deploy the AWS Lambda.",
    "Please review this source code for bugs.",
    "How do I build a Docker image?",
    "Write a function to resize an image in Python.",
    "Take a screenshot programmatically in Node.",
  ])("recognizes concrete coding work without broad keywords: %s", (prompt) => {
    expect(compiler.compile(request(prompt)).requirements.intent).toBe("coding");
  });

  it("keeps the most recent standing network denial across later follow-ups", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Search the web for the latest Quorum release.",
        "From now on, do not use the internet.",
        "Also tell me more.",
      ]),
    );

    expect(compiled.requirements.intent).toBe("research");
    expect(compiled.requirements.capabilities).not.toContain("web");
  });

  it.each([
    "What is my current medication schedule?",
    "Give me the sources for my HIV medication.",
    "What are my current payroll prices?",
  ])("does not send personal-scope freshness language to web search: %s", (prompt) => {
    const compiled = compiler.compile(request(prompt));

    expect(compiled.requirements.capabilities).not.toContain("web");
    expect(compiled.requirements.containsSensitiveData).toBe(true);
  });

  it("routes coding domains despite abstract visual language", () => {
    const prompt = "Explain the architecture diagram pattern for microservices.";
    expect(compiler.compile(request(prompt)).requirements.intent).toBe("coding");
  });

  it.each([
    "Compare image formats for archival storage.",
    "Analyze the visual design of this UI.",
  ])("does not mistake abstract visual language for an attachment: %s", (prompt) => {
    expect(compiler.compile(request(prompt)).requirements.intent).not.toBe(
      "vision",
    );
  });

  it.each([
    "Analyze this attached screenshot.",
    "Read the uploaded diagram.",
    "What is in this image?",
    "What does this PCB show?",
  ])("recognizes an explicit visual-inspection request: %s", (prompt) => {
    expect(compiler.compile(request(prompt)).requirements.intent).toBe("vision");
  });

  it.each([
    "There is no bug; tell me a joke.",
    "Do not calculate anything; just chat.",
    "What is API pricing?",
    "Analyze how I feel about this.",
    "Tell me about JS Bach.",
    "Read a TS Eliot poem.",
    "There is rust on my bicycle.",
    "Should I go to the store?",
    "How should I react to criticism?",
    "The oracle at Delphi gave an answer.",
    "She writes poetry every morning.",
    "The cargo arrived by rail.",
    "Explain angular momentum.",
    "What does a python eat?",
    "Tell me about Java coffee.",
    "Please nix that proposal.",
    "That song is groovy.",
    "Throw a dart at the board.",
    "The solidity of packed snow varies.",
    "She took a flask with her.",
    "Tell me about Cassandra in Greek mythology.",
    "I need a prettier room.",
    "Should I use the bus or go by train?",
    "There is rust on my bike with a broken chain.",
    "Build a nest for the birds.",
    "How do I install a spring on a door?",
    "Install the spring on the door.",
    "Use the flask for water.",
    "Run the dart tournament.",
    "Flutter activity in my chest worries me.",
    "We run in the spring.",
    "They work in unity.",
    "Travel via rails to the station.",
    "Use Java coffee in the recipe.",
    "That rude man is a git.",
    "Could humans terraform Mars?",
    "What is the molarity of HCl?",
    "I booked tickets at Vue cinema.",
    "Do not sass me.",
    "The museum displayed a ruby gem.",
    "Our community unity project brought neighbors together.",
    "The spring bean crop was planted early.",
    "I booked a Java class about Indonesian history.",
    "The oracle query was answered by the priestess.",
    "Tell me how to use cargo rail services.",
    "The rust test on this metal was written yesterday.",
    "What is better, plan A or C?",
    "Review the fashion models and react to their poses.",
  ])("does not route incidental keywords to an expert: %s", (prompt) => {
    expect(compiler.compile(request(prompt)).requirements.intent).toBe(
      "conversation",
    );
  });

  it.each([
    "Prove that sqrt(2) is irrational.",
    "What is 17 * 23?",
    "Solve this probability problem.",
  ])("recognizes direct mathematical reasoning: %s", (prompt) => {
    expect(compiler.compile(request(prompt)).requirements.intent).toBe(
      "reasoning",
    );
  });

  it("carries an established task through a referential follow-up", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Refactor this TypeScript function to remove duplication.",
        "Now make it faster.",
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      intentConfidence: 0.78,
      capabilities: ["chat", "coding"],
    });
  });

  it("carries specialist intent through chained contextual follow-ups", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Create a SQL PIVOT query with dynamic columns.",
        "Are there any better ways?",
        "What about for ORACLE?",
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      intentConfidence: 0.78,
      capabilities: ["chat", "coding"],
    });
  });

  it("uses the previous effective intent for a courteous referential follow-up", () => {
    const compiled = compiler.compile({
      conversationId: "conversation-1",
      policy: "balanced",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Design a backend integration.",
          createdAt: new Date(0).toISOString(),
        },
        assistantWithIntent("coding", 1),
        {
          id: "message-2",
          role: "user",
          content:
            "Thank you. Could this be used easily with desktop applications?",
          createdAt: new Date(2).toISOString(),
        },
      ],
    });

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      intentConfidence: 0.78,
      capabilities: ["chat", "coding"],
    });
  });

  it.each([
    "Are there any better ways?",
    "Is there a better approach?",
    "What other options are there?",
    "Any alternatives?",
    "What else?",
  ])("carries an established task through a comparative follow-up: %s", (prompt) => {
    const compiled = compiler.compile(
      conversationRequest([
        "Create a SQL PIVOT query with dynamic columns.",
        prompt,
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      intentConfidence: 0.78,
      capabilities: ["chat", "coding"],
    });
  });

  it.each([
    "What about Vue?",
    "What about Python instead?",
    "What about Python for this?",
    "Would Python work here?",
    "Could Python be used here?",
    "Does React work the same way?",
    "Would Terraform work for this?",
    "Python instead?",
    "Could we use Python?",
  ])("carries a named technology comparison only from an established coding task: %s", (prompt) => {
    const compiled = compiler.compile(
      conversationRequest([
        "Migrate this Angular component.",
        prompt,
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      capabilities: ["chat", "coding"],
    });
  });

  it.each([
    "What about Java?",
    "What about Java instead?",
    "Would Java work here?",
  ])("does not turn a geographic Java follow-up into a coding task: %s", (prompt) => {
    const compiled = compiler.compile(
      conversationRequest([
        "Tell me about Indonesian islands.",
        prompt,
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "default",
      capabilities: ["chat"],
    });
  });

  it("allows an explicit topic reset instead of carrying the prior route", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Solve this equation: 2x = 8.",
        "New topic: tell me a joke.",
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "default",
    });
  });

  it("does not cross an explicit reset on a later short follow-up", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Write a TypeScript function.",
        "New topic: tell me a joke.",
        "Why?",
      ]),
    );

    expect(compiled.requirements.intent).toBe("conversation");
  });

  it("does not cross an explicit reset while walking a follow-up chain", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "Create a SQL PIVOT query with dynamic columns.",
        "Are there any better ways?",
        "New topic: tell me a joke.",
        "What about that?",
      ]),
    );

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "default",
    });
  });

  it("does not carry persisted specialist intent into a courtesy-prefixed reset", () => {
    const compiled = compiler.compile({
      conversationId: "conversation-1",
      policy: "balanced",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Design a backend integration.",
          createdAt: new Date(0).toISOString(),
        },
        assistantWithIntent("coding", 1),
        {
          id: "message-2",
          role: "user",
          content: "Thank you. New topic: tell me a joke.",
          createdAt: new Date(2).toISOString(),
        },
      ],
    });

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "default",
    });
  });

  it("does not carry persisted specialist intent across a completed conversational turn", () => {
    const compiled = compiler.compile({
      conversationId: "conversation-1",
      policy: "balanced",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Design a backend integration.",
          createdAt: new Date(0).toISOString(),
        },
        assistantWithIntent("coding", 1),
        {
          id: "message-2",
          role: "user",
          content: "New topic: let's just talk.",
          createdAt: new Date(2).toISOString(),
        },
        assistantWithIntent("conversation", 3),
        {
          id: "message-3",
          role: "user",
          content: "Thanks. Could this be improved?",
          createdAt: new Date(4).toISOString(),
        },
      ],
    });

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "default",
    });
  });

  it.each([
    "continue",
    "please continue",
    "Please continue.",
    "continue with it",
    "keep going",
    "go on",
    "carry on",
  ])(
    "inherits the persisted intent for a bare continuation request: %s",
    (prompt) => {
      const compiled = compiler.compile({
        conversationId: "conversation-1",
        policy: "balanced",
        messages: [
          {
            id: "message-1",
            role: "user",
            content: "Explore biomimetic applications to computer technology.",
            createdAt: new Date(0).toISOString(),
          },
          assistantWithIntent("research", 1),
          {
            id: "message-2",
            role: "user",
            content: prompt,
            createdAt: new Date(2).toISOString(),
          },
        ],
      });

      expect(compiled.requirements).toMatchObject({
        intent: "research",
        intentSource: "conversation",
        capabilities: ["chat", "reasoning"],
      });
    },
  );

  it("inherits coding for an object-bearing continuation request", () => {
    const compiled = compiler.compile({
      conversationId: "conversation-1",
      policy: "balanced",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Implement an Oracle query in Node.js.",
          createdAt: new Date(0).toISOString(),
        },
        assistantWithIntent("coding", 1),
        {
          id: "message-2",
          role: "user",
          content: "Please continue the implementation.",
          createdAt: new Date(2).toISOString(),
        },
      ],
    });

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      capabilities: ["chat", "coding"],
    });
  });

  it("recovers the coding task after a low-confidence conversational misroute", () => {
    const misroutedConversation = assistantWithIntent("conversation", 3);
    if (misroutedConversation.execution) {
      misroutedConversation.execution.plan.analysis.confidence = 0.5;
      misroutedConversation.execution.plan.analysis.source = "hybrid";
    }
    const compiled = compiler.compile({
      conversationId: "conversation-1",
      policy: "balanced",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Create a dynamic SQL PIVOT query.",
          createdAt: new Date(0).toISOString(),
        },
        assistantWithIntent("coding", 1),
        {
          id: "message-2",
          role: "user",
          content: "Could this be used easily with JS applications?",
          createdAt: new Date(2).toISOString(),
        },
        misroutedConversation,
        {
          id: "message-3",
          role: "user",
          content: "Thanks. Could this be made asynchronous?",
          createdAt: new Date(4).toISOString(),
        },
      ],
    });

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      capabilities: ["chat", "coding"],
    });
  });

  it("does not treat a new what-about subject as a persisted coding follow-up", () => {
    const compiled = compiler.compile({
      conversationId: "conversation-1",
      policy: "balanced",
      messages: [
        {
          id: "message-1",
          role: "user",
          content: "Design a backend integration.",
          createdAt: new Date(0).toISOString(),
        },
        assistantWithIntent("coding", 1),
        {
          id: "message-2",
          role: "user",
          content: "What about the weather?",
          createdAt: new Date(2).toISOString(),
        },
      ],
    });

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "default",
    });
  });

  it.each([
    "What should I cook this weekend?",
    "Tell me about this composer.",
    "What is the source of this error?",
  ])("does not treat an unrelated use of a pronoun as a follow-up: %s", (prompt) => {
    const compiled = compiler.compile(
      conversationRequest(["Write a TypeScript function.", prompt]),
    );

    expect(compiled.requirements.intent).toBe("conversation");
  });

  it("detects sensitive data anywhere in the context sent to a model", () => {
    const compiled = compiler.compile(
      conversationRequest([
        "My private key is in the earlier message.",
        "Now summarize that.",
      ]),
    );

    expect(compiled.requirements.containsSensitiveData).toBe(true);
  });

  it.each([
    "xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx",
    "sk_live_1234567890abcdefghijklmnop",
    "postgres://admin:Sup3rS3cret@database.example/app",
    "4111 1111 1111 1111",
    "INTERNAL ONLY Project Falcon roadmap",
    "AccountKey=abcdefghijklmnopqrstuvwxyz012345",
  ])("detects common credential and restricted-data forms: %s", (value) => {
    expect(containsSensitiveContent(value)).toBe(true);
  });

  it.each([
    ["AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz1234567890ABCD", "credentials"],
    ["GOOGLE_API_KEY=AIzaSyA123456789012345678901234567890123", "credentials"],
    ["SSN 123456789", "government_id"],
    ["DB_PASS=hunter2-example", "credentials"],
    ["IBAN: GB82WEST12345698765432", "financial"],
    ["email: person@example.com", "personal_contact"],
    ["my medical diagnosis is private", "health"],
    ["pаssword\u200B=hidden-value", "credentials"],
    [
      "Jane Q. Doe, born 1984-03-11, 12 Elm St, 555-867-5309",
      "personal_contact",
    ],
    ["I was just diagnosed with stage 2 lymphoma", "health"],
    [
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDgL7SFnKcY3Q8u",
      "private_key",
    ],
  ])("detects normalized sensitive %s data", (value, category) => {
    const compiled = compiler.compile(request(value));

    expect(compiled.requirements.containsSensitiveData).toBe(true);
    expect(compiled.requirements.sensitiveDataCategories).toContain(category);
  });

  it.each([
    "How do I hash a password with bcrypt in Node?",
    "Explain what an API key is.",
    "What does 'confidential' mean in a legal contract?",
    "Order number 4532015112830366 shipped today",
  ])("does not poison a conversation for non-secret language: %s", (value) => {
    expect(containsSensitiveContent(value)).toBe(false);
  });

  it("does not treat assistant-authored secret terminology as user data", () => {
    const compiled = compiler.compile({
      ...request("Can you expand on that?"),
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "A password is an authentication secret.",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "user-2",
          role: "user",
          content: "Can you expand on that?",
          createdAt: new Date(1).toISOString(),
        },
      ],
    });

    expect(compiled.requirements.containsSensitiveData).toBe(false);
  });

  it("marks prior web-grounded assistant output as local-only context", () => {
    const compiled = compiler.compile({
      ...request("Compare that with the alternative."),
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          content: "A web-grounded answer.",
          provenance: "web_grounded",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "user-2",
          role: "user",
          content: "Compare that with the alternative.",
          createdAt: new Date(1).toISOString(),
        },
      ],
    });

    expect(compiled.requirements.containsWebGroundedData).toBe(true);
  });

  it("uses a confident local prompt analysis for an ambiguous request", () => {
    const baseline = compiler.compile(request("Can you help me with this?"));
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "coding",
        confidence: 0.91,
        taskSummary: "Help with the current coding task.",
      },
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentConfidence: 0.91,
      intentSource: "classifier",
      capabilities: ["chat", "coding"],
    });
    expect(compiled.analysis).toMatchObject({
      source: "local_model",
      intent: "coding",
      taskSummary: "Help with the current coding task.",
      analyzer: {
        modelId: "local:classifier:test",
        modelLabel: "Tiny classifier",
      },
    });
  });

  it("never lets classifier output authorize network search", () => {
    const baseline = compiler.compile(request("Can you help me with this?"));
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "research",
        confidence: 0.99,
        taskSummary: "Search for current information.",
      },
    );

    expect(compiled.requirements).toMatchObject({
      intent: "research",
      intentSource: "classifier",
      capabilities: ["chat", "reasoning"],
      requiresFreshness: false,
    });
  });

  it("keeps a strong deterministic signal when the tiny model conflicts", () => {
    const baseline = compiler.compile(
      request("Write a SQL query for dynamic pivot columns."),
    );
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "conversation",
        confidence: 0.9,
        taskSummary: "Discuss database tables.",
      },
    );

    expect(compiled.requirements.intent).toBe("coding");
    expect(compiled.analysis).toMatchObject({
      source: "hybrid",
      intent: "coding",
      analyzer: {
        intent: "conversation",
        confidence: 0.9,
      },
    });
  });

  it("does not let the prompt expert turn architecture analysis into a document task", () => {
    const baseline = compiler.compile(
      request(
        "Compare a modular architecture with a monolith, then recommend a starting point.",
      ),
    );
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Prompt expert" },
      {
        intent: "document",
        confidence: 1,
        taskSummary: "Compare two software architectures.",
      },
    );

    expect(compiled.requirements).toMatchObject({
      intent: "reasoning",
      intentConfidence: 0.9,
      capabilities: ["chat", "reasoning"],
    });
    expect(compiled.analysis).toMatchObject({
      source: "hybrid",
      intent: "reasoning",
      analyzer: { intent: "document", confidence: 1 },
    });
  });

  it("allows the prompt expert to correct a contextual software-name guess", () => {
    const baseline = compiler.compile(
      request("Explain the React state of this art exhibition."),
    );
    expect(baseline.requirements).toMatchObject({
      intent: "coding",
      intentConfidence: 0.82,
    });

    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Prompt expert" },
      {
        intent: "conversation",
        confidence: 0.95,
        taskSummary: "Discuss an art exhibition.",
      },
    );

    expect(compiled.requirements).toMatchObject({
      intent: "conversation",
      intentSource: "classifier",
    });
  });

  it("protects inherited specialist context from a contradictory tiny model", () => {
    const baseline = compiler.compile(
      conversationRequest([
        "Create a SQL PIVOT query with dynamic columns.",
        "Are there any better ways?",
      ]),
    );
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "conversation",
        confidence: 1,
        taskSummary: "Discuss alternative approaches.",
      },
    );

    expect(compiled.requirements).toMatchObject({
      intent: "coding",
      intentSource: "conversation",
      capabilities: ["chat", "coding"],
    });
    expect(compiled.analysis).toMatchObject({
      source: "hybrid",
      intent: "coding",
      analyzer: {
        intent: "conversation",
        confidence: 1,
      },
    });
  });

  it("never lets prompt analysis clear deterministic sensitive-data detection", () => {
    const baseline = compiler.compile(
      request("Use API key sk-exampleSecret12345 to help with this."),
    );
    const compiled = compiler.applyPromptAnalysis(
      baseline,
      { id: "local:classifier:test", label: "Tiny classifier" },
      {
        intent: "conversation",
        confidence: 0.95,
        taskSummary: "Help with a request.",
      },
    );

    expect(compiled.requirements.containsSensitiveData).toBe(true);
  });

  it.each([
    "Customer credential AKIAIOSFODNN7EXAMPLE",
    "The account number is 123-45-6789",
    "Use this API key for the request",
    "OPENAI_API_KEY=sk-exampleSecret12345",
    "api_key=private-value",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
  ])("recognizes common structured secret and credential signals: %s", (prompt) => {
    expect(
      compiler.compile(request(prompt)).requirements.containsSensitiveData,
    ).toBe(true);
  });
});
