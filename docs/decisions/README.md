# Decision records

## What an ADR is, and what it is not

An ADR records **why a decision was made, at the time it was made**. It is a log entry.

`docs/architecture.md` records **what is true now**. It is the live document.

The rule that follows, and the reason this file exists:

> **A reader should never have to open an ADR to learn how the system currently works.**
> If they do, `architecture.md` is stale and that is the bug.

**An ADR does not constrain current work.** It is not a rulebook, not a policy, and not
an authority to cite against a proposal. It explains what was decided *given what was
known then*. When the reasoning stops holding, you write a new record that supersedes it
— you do not obey the old one.

This is not a technicality. An assistant working in this repository cited ADR 0001 at the
owner as though it forbade a change, arguing "the ADR scopes the shell as a thin
supervisor, therefore this is out of bounds." The owner's reply was the correct one:

> "I didn't write ADR01, so I don't know what it says. I don't particularly care if it
> points us in a direction if it turns out that direction won't help us."

The argument that actually settled that question was a fact about the code — the API
already writes files, so the desktop shell was not a prerequisite. The ADR citation was
decoration on a conclusion reached another way, and it was the weaker half presented as
the stronger. **If your argument needs an ADR to stand up, you do not yet have an
argument.**

## Status

Exactly one of these, on the third line of the file:

| Status | Meaning |
| --- | --- |
| `Proposed` | Undecided. **Nothing may be built as though this were settled**, and it must not be cited as how the system works. |
| `Accepted` | Decided. `architecture.md` reflects it. |
| `Superseded by NNNN` | A later record replaced it. Left in place; the reasoning is still worth reading. |

A `Proposed` record describing a target is legitimate — ADR 0002 describes eleven model
slots where the code has three — provided nothing treats it as current state. That is the
failure mode to watch: a proposal accumulating detail until readers mistake it for the
architecture.

## Writing one

1. **State the problem before the decision.** A record whose Context section is a summary
   of the Decision section is not evidence of anything.
2. **Say what you rejected and why.** The alternatives are the part future readers need;
   the chosen option is usually reconstructable, the discarded ones never are.
3. **Include a "What this does not constrain" section.** One or two lines. This is the
   direct fix for the failure above — an ADR that names its own limits is much harder to
   wield as a general prohibition.
4. **Accepting it updates `architecture.md` in the same change.** The record explains
   *why*; the architecture doc states *what*. Both, or neither. An accepted ADR whose
   consequences never reached `architecture.md` has created exactly the situation the rule
   at the top forbids.
5. **Never edit an accepted record to match the present.** Mark it superseded and write a
   new one. Editing history to agree with today destroys the reasoning, which was the only
   durable thing in it.

## Checking that any of this worked

Documentation drifts from behaviour silently, because nothing tests prose. `scripts/doc-probe.mjs`
gives models the documentation alone and scores what they conclude against known-correct
answers — a reader comprehension test rather than a review. It has already caught a defect
that three reviewers and the author missed.

If a record or a doc change is meant to make something clear, the probe is how you find
out whether it did. "I clarified it" and "a reader now gets it right" are different
claims, and this repository's rule 1 exists because the gap between those two is where
defects live.
