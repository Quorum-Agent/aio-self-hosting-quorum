# Working rules for Quorum

Guidance for anyone — human or assistant — changing this repository.

`docs/architecture.md` is the durable design. `REDTEAM-FINDINGS.md` is the durable record
of what has been tried, found, and disproved; read the section relevant to whatever you
are about to touch, because several of its entries exist specifically to stop a fix being
re-attempted.

---

## Rule 1 — prove the change is not cosmetic

**Break it, run the suite, confirm something turns red, revert.** If reverting your change
leaves the suite green, the change enforced nothing, whatever it reads like.

This is the rule the rest of the document elaborates, and it is not a style preference.
It is here because a passing test and a meaningful test are indistinguishable from the
outside, and this repository has produced the difference repeatedly:

- Two documented security invariants were enforced by **no test at all**. Deleting the
  policy cloud-exclusion filter left the entire suite green while private-mode requests
  routed to cloud.
- A test named for private mode passed whether or not the filter existed, because its
  fixture lost on sorting arithmetic before policy was ever consulted.
- Renaming a policy's tool ceiling from `"cloud"` to `"web"` — a genuine tightening —
  failed no test until one was written for it.
- The guard added to prevent the fixture problem was itself extended to new fixtures by
  **hard-coding the value it was meant to guard**.

Four of those were written by someone who had just finished fixing the previous one.

### How

```
1. edit the source so the property is false
2. run the workspace suite
3. read which tests failed, and whether they are the ones you expected
4. restore the source
```

Record the failing count in the commit message. "Mutation-verified: removing X fails 3
tests" is a claim a reviewer can check; "added tests" is not.

### What is exempt

Formatting, typos, comments that describe rather than assert, and renames with no
behavioural surface. If you are unsure whether a change has a behavioural surface, that
uncertainty is itself the answer — mutate it and find out.

---

## Corollaries, each earned the hard way

**A fixture must be able to reach the wrong answer.** If the scenario your test guards
against cannot occur with the values in the test, the test is decoration. Assert the
fixture's discriminating power explicitly where the arithmetic is non-obvious — see the
guard in `packages/core/src/security-invariants.test.ts`.

**A guard must read the value it guards, not a copy.** A check holding its own literal
drifts silently the moment the thing it protects is edited.

**Assert that two fields agree, not that either is plausible.** Most defects here take
the shape *one fact, two fields, read by different surfaces*. The worst example had a
**correct** disclosure throughout — the plan honestly reported egress while the policy
was being bypassed — so any "did we tell the user the truth" check would have called it
healthy. Prefer properties over examples for this: a property has no fixture to get
wrong.

**Execute against the pinned dependency version.** Documentation and upstream issues
describe whatever branch their author read. An upstream bug adopted from a research
report, with an explicit version caveat, did not reproduce on the pinned llama.cpp build
and had already reshaped a plan by the time that was checked.

**Reading tests cannot tell you what they enforce.** Two "known open gaps" recorded in
`REDTEAM-FINDINGS.md` turned out to be covered all along; one was manufactured by
grepping for a parameter name against a call that passes it positionally.

---

## Known traps in this repository

- **`npm test` at the root may OOM** on a loaded machine — an esbuild issue, not a test
  failure. Run workspaces individually with
  `npx vitest run --pool=forks --poolOptions.forks.singleFork=true`.
- **Vitest silently excludes `vite.config.*`**, so a test file named `vite.config.test.ts`
  never runs and never reports. Name config-adjacent tests something else.
- **`@quorum/core` resolves to `dist/` unless the `development` condition is set.** The
  dev script passes it; ad-hoc `npx tsx` does not, so a stale build will appear to be a
  source bug.
- **The GPU is shared.** Benchmarks and the GGUF load gate produce false failures under
  contention — an oversized or squeezed model reports *less* resident VRAM, not more.
  Check free memory before trusting a "does not load" verdict.

---

## Before opening a PR

Run the affected workspaces and `npm run typecheck`. State in the PR body what you
mutated and what turned red. If a change is user-visible, say what a user would have
seen before and after — several defects here were only legible once described that way.
