# Design Docs

A design doc is the durable statement of intent for **one system**: what it's for, what words mean, what must always hold, and what it deliberately doesn't do. It lives at `thoughts/<username|shared>/design-docs/<system-slug>.md` — **no date prefix**; it's a living doc, amended in place, never superseded by a new dated file.

It is **normative**: the `desplega:code-reviewing` Spec axis checks diffs against the Invariants section, and researching/planning/one-shot must read-and-abide (below). A design doc nobody enforces is a wish; this one is enforced at review time.

## Structure (in this order — template at `template.md`)

1. **Purpose** — one paragraph. What the system is for and for whom. If it takes two paragraphs, the system boundary is probably wrong.
2. **Glossary** — the ubiquitous language: each core term, one-line definition, plus **"avoid:"** aliases (terms people misuse for it). Zero implementation detail — a glossary entry naming a class or table has leaked.
3. **Invariants** — numbered (`I1`, `I2`, …), each one **testable** — a reviewer must be able to look at a diff and answer "does this hold?" with yes/no. These are spec, not style; vague aspirations ("should be fast") don't belong here.
4. **Boundaries & Non-goals** — what the system explicitly does NOT do, including **rejected scope with the reason it was rejected** (so the next person doesn't re-propose it from scratch).
5. **Interfaces / Seams** — how other systems touch this one, high level only (names and responsibilities, not signatures).
6. **Decision log** — one-paragraph ADR entries, newest first: context → decision → consequence. Only decisions that are **hard to reverse, surprising, or a real trade-off** — routine choices are noise here.
7. **Amendment log** — one line per change to this doc: date, what changed, which plan/session drove it.

## Creating one

On demand, when a system is worth pinning down. Grilling-style Q&A (same rules as `desplega:brainstorming`):

- **Facts vs decisions** — never ask what you can look up. Current behavior, existing terms, actual boundaries: spawn quick background sub-agents (routed per `desplega:delegate-work`) and draft from findings. Only genuine decisions — naming calls, invariant strength, scope rejections — go to the user, via `AskUserQuestion` with a recommended answer on every question.
- Draft the doc from the template, section by section, filling what research settled and asking only what it couldn't.
- Finish with `/file-review:file-review <path>` so the user can mark up the draft.

## Amending

Design docs change through work, not drift: when a plan or one-shot intentionally changes the design, updating the doc is part of that work — append the Decision log entry (if the change was a real decision) and the Amendment log line in the same session. There is **no periodic drift audit** by design; enforcement is read-and-abide plus the review Spec axis.

## Read-and-abide (enforcement)

For any skill touching a system that has a design doc:

- **Read it first.** The Glossary is canonical vocabulary for anything you write about the system.
- **Don't violate it.** Invariants and Boundaries constrain plans and code alike.
- **Flag conflicts, never silently work around them.** If the task requires breaking an invariant or crossing a boundary, surface it to the user as an explicit decision (which, if taken, amends the doc). If existing *code* contradicts the doc, report that as a finding — doc says X, code does Y — and let the user pick which one is wrong.

Wired into: `desplega:researching` and `desplega:planning` (read-and-abide rules), `desplega:one-shot` (Step 2), `desplega:code-reviewing` (Invariants as Spec-axis source).
