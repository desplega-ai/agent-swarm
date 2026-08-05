# Ask User

Thin helper that codifies how to ask the user questions during a workflow. Other skills (planning, research, brainstorming, implementing) reference this skill instead of duplicating AskUserQuestion conventions.

## Core Rule

**Use the AskUserQuestion tool — never as plain-text bullets in chat.**

Asking in chat looks like a request for free-form prose; AskUserQuestion gives the user one click per decision and the answer is structured. Always prefer the tool.

## When to Use

- Clarifying ambiguous user input
- Choosing between viable design options
- Confirming a non-trivial assumption before acting on it
- Approving a phase boundary, plan structure, or destructive action
- Capturing a workflow preference (e.g., commit-per-phase)

## When NOT to Use

- Rhetorical questions or thinking-out-loud
- Asking permission for trivial, reversible actions (just do them)
- "Is the plan ready?" / "Should I proceed?" — those are not decisions, they're checkpoints; just present the artifact and stop

## Conventions

### Question shape

- **One sentence**, ends with `?`
- Include enough context that the user doesn't need to scroll back
- Don't reference invisible artifacts ("does the plan look good?" — they may not see it yet)

### Options

- 2–4 mutually exclusive choices
- Each option: 1–5 word **label**, plus a one-sentence **description** explaining the trade-off or implication
- If you have a recommendation, put it **first** and append `(Recommended)` to the label
- Never include "Other" — the tool adds it automatically

### Header chip

- Max 12 characters, names the *axis* of the choice (e.g. `Auth method`, `Approach`, `Scope`)

### Multi-select

Use `multiSelect: true` only when choices are non-exclusive (e.g., "which features to enable?"). Default is single-select.

### Batching

If you have multiple independent questions to ask at the same checkpoint, send them in **one** AskUserQuestion call (up to 4 questions) — don't ping-pong.

## Good Example

```
question: "Which storage backend should the worker use?"
header: "Storage"
options:
  - label: "Postgres (Recommended)"
    description: "Existing infra, transactional, easy to query. Adds one new schema."
  - label: "Redis"
    description: "Faster but requires new ops. Lossy on eviction — bad fit for audit data."
  - label: "S3 + manifest"
    description: "Cheapest at scale but adds latency and a sync layer."
```

## Bad Examples

```
"What do you think?"                      → too vague, no options
"Should I continue? (yes/no)"             → checkpoint, not a decision; just stop
"Pick one: A, B, C, D, E, F, G"           → too many options; collapse or split
"Want me to also fix the typo?"           → trivial reversible action; just do it
```
