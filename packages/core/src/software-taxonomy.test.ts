import { describe, expect, it } from "vitest";

import {
  CONTEXTUAL_SOFTWARE_PHRASES,
  CONTEXTUAL_SOFTWARE_TERMS,
  detectSoftwareReference,
  isNamedSoftwareFollowUp,
  SOFTWARE_TERMS,
} from "./software-taxonomy.js";

describe("software taxonomy", () => {
  it.each(Object.values(SOFTWARE_TERMS).flat())(
    "recognizes the strong software term %s",
    (term) => {
      expect(detectSoftwareReference(`Could you help me with ${term}?`)).toBe(
        "strong",
      );
    },
  );

  it.each(CONTEXTUAL_SOFTWARE_TERMS)(
    "recognizes the contextual software term %s near code",
    (term) => {
      expect(detectSoftwareReference(`Refactor this ${term} code.`)).toBe(
        "contextual",
      );
    },
  );

  it.each(CONTEXTUAL_SOFTWARE_PHRASES)(
    "recognizes the contextual software phrase %s",
    (phrase) => {
      expect(detectSoftwareReference(`Please help with this ${phrase}.`)).toBe(
        "contextual",
      );
    },
  );

  it.each([
    "The shell washed up on the beach.",
    "There is rust on my bicycle.",
    "She writes poetry every morning.",
    "The cargo arrived by rail.",
    "Should I go to the store?",
    "How should I react to criticism?",
    "The oracle at Delphi gave an answer.",
    "Swift action prevented a problem.",
    "Ruby is a gemstone.",
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
  ])("does not treat ordinary prose as a software reference: %s", (prompt) => {
    expect(detectSoftwareReference(prompt)).toBeUndefined();
  });

  it.each([
    "What about Java?",
    "How about Vue?",
    "Would Terraform be any different?",
    "What about Python instead?",
    "What about Python for this?",
    "Would Python work here?",
    "Could Python be used here?",
    "Does React work the same way?",
    "Would Terraform work for this?",
    "Python instead?",
    "Could we use Python?",
  ])("recognizes a named software follow-up without assigning its intent: %s", (prompt) => {
    expect(isNamedSoftwareFollowUp(prompt)).toBe(true);
    expect(detectSoftwareReference(prompt)).toBeUndefined();
  });

  it("rejects oversized named-follow-up near misses before regex matching", () => {
    expect(
      isNamedSoftwareFollowUp(`Would Python be${" ".repeat(1_000_000)}X`),
    ).toBe(false);
  });
});
