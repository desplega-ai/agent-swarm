# v-planning

You create implementation plans as a **DAG of vertical steps** — each step a complete, QA-able slice of value (DB + API + UI + tests for one feature). The DAG captures feature-level dependencies, so independent steps can be implemented in parallel by sub-agents.

Output is a plan **directory** at `thoughts/<username|shared>/plans/YYYY-MM-DD-description/`:

```
root.md            # Overview, mermaid DAG, step index, Global Verification
step-1.md          # frontmatter (id, name, depends_on) + Success Criteria
step-2.md
└── step-N.md
```

## Setup (before starting)

1. **Autonomy Mode** — passed by the invoking command; default to **Critical** if unspecified.

   | Mode | Behavior |
   |------|----------|
   | **Autopilot** | Research independently, write the full plan dir, present for final review only |
   | **Critical** (Default) | After each research step, ask clarifying questions before drafting; surface design options especially at DAG decomposition |
   | **Verbose** | Check in at every sub-step: validate understanding, confirm scope, surface unknowns, confirm before writing each step file |

2. **Commit preference** — unless Autopilot, ask once via `AskUserQuestion`:

   | Question | Options |
   |----------|---------|
   | "Create a commit after each step once manual verification passes?" | 1. Yes (Recommended), 2. No, I'll handle commits |

3. **Prior learnings** — **OPTIONAL SUB-SKILL:** if `~/.agentic-learnings.json` exists, run `/learning recall <topic>` first.

## The 10 Rules

1. **Scaffold first** — before any research, exit plan mode and create the plan directory with `root.md` from `templates/root.md`. (Use the user's name when known, e.g. `taras`; fall back to `thoughts/shared/` otherwise.) Step files are added as the DAG emerges in rule 4. The directory grows incrementally; the user can correct course early.

2. **Sub-agent everything heavy** — file reads, research, validation. Default `run_in_background: true`. Keep raw tool output out of the main session.
   *Sub-agent menu*: `codebase-locator` (find files), `codebase-analyzer` (understand current implementation), `codebase-pattern-finder` (find similar features), `context7` MCP (library/framework specifics), `Explore` or `general-purpose` (read mentioned files).

3. **Ask via `AskUserQuestion`** — see `desplega:ask-user` for conventions. Never ask in chat as plain bullets.

4. **Ask after each step (Critical/Verbose), then loop** — work the plan section by section: **Current State Analysis → Implementation Approach → DAG Decomposition → Per-Step Details**. For each section: spawn sub-agents → synthesize findings (with `file:line` refs) → ask gaps via `AskUserQuestion` → draft → next section.
   - **DAG Decomposition**: identify vertical slices (each QA-able on its own), their dependencies, and any explicit integration step. Present the proposed step list + mermaid graph and confirm shape via `AskUserQuestion` before drafting step files.
   - **Per-Step Details**: create each `step-<n>.md` from `templates/step.md`. Frontmatter `depends_on: [step-X, ...]` is **canonical**; `root.md`'s mermaid graph + step-index table is a derived view — keep them in sync.

5. **Concrete deliverable per step (vertical slice)** — every step's Overview names what file/feature/output exists when it's done. **Each step must be QA-able on its own.** Layer-only steps ("DB migration", "just the endpoint") are smells — collapse them into vertical slices. "Improve X" and "refactor Y" are also smells.

6. **Proof of work: maximize Automated Verification + Automated QA** — push everything into runnable commands (low-level) and agent-driven QA (browser-use, screenshot diff, CLI walkthrough). Manual Verification is the exception. Each step has its own Success Criteria block; `root.md` has `## Global Verification` for cross-cutting checks that only fire after the whole DAG drains. A `### QA Spec (optional):` linking to a `desplega:qa` doc is reserved for cross-cutting / evidence-heavy QA — not routine per-step checks.

7. **Propose splitting** — when a step has >4 sub-steps or >2 distinct concerns, split into multiple DAG nodes (wire deps appropriately). When the whole DAG won't fit one parallel implementation session, split into multiple plans (e.g., contract → storage → UI). A linear DAG is accepted but worth flagging — the linear `planning` skill may fit better.

8. **Push back with radical candor** — use `desplega:feedback` when the plan is too big, vague, mixes concerns, or has obvious risks. Silence is Ruinous Empathy.

9. **Validate structure with a Haiku sub-agent** before showing the plan (`general-purpose` with `model: haiku`). Verify: every `step-<n>.md` has all three Success Criteria subsections (Automated Verification + Automated QA + Manual Verification); all items use `- [ ]`; automated checks are runnable commands; every step's `depends_on` references an existing step ID; no cycles in the DAG; `root.md`'s mermaid graph + step-index table agree with step frontmatter; **every step's frontmatter has `status: ready`** (a fresh plan; transitions happen during `/v-implement`); referenced paths exist. Apply fixes *before* reveal.

10. **Hand off to a fresh session — never implement here.** Close-out:
    1. Open `/file-review:file-review <plan-dir>/root.md` (unless Autopilot); iterate on comments. Re-open with individual `step-<n>.md` files if needed.
    2. Optionally invoke `desplega:reviewing` for gap analysis (offer via `AskUserQuestion`).
    3. **OPTIONAL SUB-SKILL:** if significant insights emerged, capture via `/learning capture`.
    4. **If any step has a `### QA Spec (optional):` block**, generate the QA doc via `desplega:qa` *before* handoff (`thoughts/<username|shared>/qa/YYYY-MM-DD-[feature].md`). Scenarios live in the doc, not the plan.
    5. Ask via `AskUserQuestion`:

       | Question | Options |
       |----------|---------|
       | "Plan ready. What's next?" | 1. Implement in a fresh session, 2. Run `/review` first, 3. Done for now (park the plan) |

    6. Tell them explicitly: "Open a new Claude Code session and run `/desplega:v-implement <plan-dir>`. Starting fresh keeps the implementation context clean."

## DAG Specifics

- **Frontmatter is canonical for deps.** `root.md`'s mermaid graph is derived. If they disagree, frontmatter wins.
- **Self-contained steps.** A sub-agent handed only one `step-<n>.md` (plus plan-level context from `root.md`) should be able to implement it without reading sibling steps.
- **Frontmatter carries execution state.** Initial `status: ready` on every step; `desplega:step-running` transitions it through `claimed` → `done` (or back to `ready` on retry-able failure) and writes `assignee` / `claimed_at` while claimed. This makes the same plan dir safe to drive from multiple orchestrator instances. The body of the step (Changes Required, Success Criteria) is immutable during execution — only frontmatter and checkbox state change.
- **Integration steps are explicit when needed.** If parallel siblings need non-trivial stitching (cross-cutting e2e, shared-surface reconciliation), add an explicit `step-N` with `depends_on: [step-X, step-Y, ...]` whose work is "stitch + e2e". Otherwise the DAG just terminates at its leaves.

## Commit Integration

If commit-per-step was enabled in Setup:
- After each step's manual verification passes, commit with format `[step-N] <brief description>`.
- Only commit after explicit confirmation that manual verification passed.
- Otherwise, skip — the user handles commits.

## Success Criteria Format (MANDATORY)

Canonical format and heading hierarchy live in:
- `templates/root.md` (`## Global Verification`)
- `templates/step.md` (per-step three-bucket Success Criteria)

Structure validation runs automatically (rule 9, Haiku sub-agent).
