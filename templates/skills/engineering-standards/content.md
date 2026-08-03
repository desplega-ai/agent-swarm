# engineering-standards

The goal is always the same: **solve the problem with the least code and the least complexity that actually solves it.** Not the cleverest solution, not the most extensible one — the one a senior engineer would defend in review. Every rule below is phrased as a *checkable test*, not a slogan: if you can't run the test, the rule doesn't apply; if the test fails, change the code.

**The repo overrides.** A documented repo standard (CLAUDE.md, AGENTS.md, `runbooks/`, contributing docs, lint config) always wins over this baseline. This skill fills the gaps; it never argues with the repo.

## The tests

1. **The deletion test** — imagine deleting the module/abstraction/layer. If the complexity vanishes, it was a pass-through: delete it for real. If the complexity reappears spread across N callers, it was earning its keep.
2. **The two-adapters rule** — one implementation behind an interface is a hypothetical seam; two is a real one. Don't introduce an interface, strategy, plugin point, or config flag unless something *actually varies* across it today. "We might need it later" fails this test by definition (YAGNI).
3. **The inline test** — could this helper/wrapper/abstraction be inlined at its call sites with *less total code*? Then inline it. Indirection must pay for itself in removed duplication or hidden complexity.
4. **The diff test** — is every hunk in the diff required by the stated goal? Drive-by refactors, "while I'm here" cleanups, renamed variables, and reformatted neighbors belong in separate commits or not at all. The smallest diff that solves the problem is the best diff. One deliberate exception: docs that document the changed thing (runbooks, design-guide showcases, design docs) update in the *same* diff — keeping the source of truth in sync is part of the change, not scope creep.
5. **The explanation test** — can you explain the design in two sentences to someone who knows the codebase? If the explanation needs a diagram, the design is probably too clever for the problem size (KISS).
6. **The new-dependency test** — a new package must clear a higher bar than new code: is it maintained, is it doing something genuinely hard (crypto, parsing, dates), and would the hand-rolled version be >100 lines? Otherwise write the 20 lines.

**Deleting code is the best outcome.** A change that solves the problem by removing code beats one that adds it. Always check whether the problem is an existing abstraction that should die, before building a new one on top (see Sediment, below).

## Smell baseline (Fowler, condensed)

When writing or reviewing, scan for these; each names the fix:

| Smell | Fix direction |
|-------|---------------|
| Speculative Generality (hooks/params nothing uses) | delete until needed (test 2) |
| Middle Man (class that only delegates) | inline it (tests 1, 3) |
| Mysterious Name | rename to what it does |
| Duplicated Code | extract — but only on the 2nd+ real occurrence |
| Feature Envy (method living off another module's data) | move it to that module |
| Data Clumps (same 3 params travelling together) | introduce the object |
| Primitive Obsession (stringly-typed domain ideas) | introduce the type |
| Repeated Switches (same switch in N places) | polymorphism / lookup map |
| Shotgun Surgery (one change touches 8 files) | consolidate the concern |
| Divergent Change (one file changes for 8 reasons) | split the concerns |
| Message Chains (`a.b().c().d()`) | hide the traversal |
| Sediment (stale layers kept "because removing feels risky") | delete; git remembers |

Duplication note: the rule is "extract on the second *real* occurrence" — two similar-looking blocks with different reasons to change are NOT duplication, and unifying them creates coupling worse than the repetition.

## Pushback protocol (radical candor)

Silently implementing a design you believe is over-built is Ruinous Empathy. When a request, plan phase, or existing pattern fails one of the tests above, push back at these checkpoints — using `desplega:feedback` (bundled with this plugin; same skill as `radical-candor:feedback`):

- **Before drafting a plan phase** that introduces an abstraction/layer/dependency: "Are you sure about the X layer? It fails the two-adapters test — only one implementation exists and nothing on the roadmap adds a second. The direct version is ~N lines."
- **Before implementing** a spec'd design you'd reject in review: raise it once, concretely, with the simpler alternative sketched. If the user confirms, implement their version without relitigating.
- **When reviewing**, standards findings cite the failed test by name — "fails the deletion test" beats "seems over-engineered".

One concrete objection with the alternative attached, then respect the decision. Pushback is a checkpoint, not a filibuster.

## Persisting team standards: `runbooks/`

Teams extend or override this baseline by persisting their own standards in the project root as **runbooks**:

```
runbooks/index.md            # hub: one line + link per runbook
runbooks/<slug>.md           # flat for small sets…
runbooks/<name>/<slug>.md    # …or grouped by area when they multiply
```

- Each runbook is one durable standard or procedure (naming rules, error-handling policy, testing strategy, release flow) — current behavior only, no history.
- Root `CLAUDE.md`/`AGENTS.md` gets a one-line pointer per runbook (`Full rules: [runbooks/<slug>.md](./runbooks/<slug>.md)`) plus a hub mention of `runbooks/` — the pointer is what makes agents *find* them; an unreferenced runbook is dead weight. Edit whichever of the two files exists; never create one from scratch.
- Runbooks ARE repo standards: `desplega:code-reviewing`'s Standards axis must load the relevant ones, and they override this skill's baseline on conflict.
- **Be proactive**: when the user states a standard for the second time in a session, or a review keeps flagging the same team-specific convention, offer to persist it as a runbook (update `index.md` and the CLAUDE.md/AGENTS.md pointer in the same edit). Update the affected runbook in the same PR whenever the behavior it documents changes.

## Where this applies

- **Writing code** (any executor): the tests bound what gets written. Codex prompts inherit them — include "smallest diff that solves the problem; no speculative abstractions" in the prompt contract.
- **Reviewing code**: this skill is the standards baseline for `desplega:code-reviewing`'s Standards axis (repo standards still override).
- **Planning**: phases that add layers, interfaces, or dependencies justify them against tests 1–2 and 6 in the phase Overview, or get flagged via the Pushback protocol.
