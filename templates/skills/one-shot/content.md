# One-Shot

Plan and implement a small task in a single session. This is the lightweight sibling of the `create-plan` → `implement-plan` pipeline: same discipline (written plan, verification, code review), a fraction of the ceremony.

## Scope gate (HARD rule)

One-shot is for small work only: **at most ~3 phases, one subsystem**. Check this at every stage — assessment, planning, and mid-implementation. The moment the work reveals more phases or a second subsystem, **STOP**:

1. Tell the user what grew and why.
2. Hand off to `/desplega:create-plan`, passing the yolo plan (whatever exists of it) as input context.

Grinding on past the gate is how one-shots turn into unreviewable mega-diffs. Escalating is success, not failure.

## Step 1: Assess ceremony

Read the prompt and decide dynamically:

- **Clear enough** (goal unambiguous, approach obvious, no real trade-offs) → **GO**. No questions.
- **Not clear** → one lowkey grill: a **single bundled `AskUserQuestion` call** with 2–3 decisions max, every question shipping a recommended answer (per `desplega:ask-user` conventions). Facts-vs-decisions rule applies (as in `desplega:brainstorming`): look up facts yourself — via quick background sub-agents routed per `desplega:delegate-work` — and only bring genuine decisions to the user. One round only; if the answers reveal a swamp, that's the scope gate firing.

## Step 2: Yolo plan — written as you go

Create `thoughts/<username|shared>/plans-yolo/YYYY-MM-DD-<slug>.md` (user's name when known, else `shared`) **before implementing**, then keep it current while you work — it is a running log, not an upfront artifact:

```markdown
---
date: YYYY-MM-DDTHH:MM:SSZ
topic: "<Task>"
status: in-progress   # in-progress | done | escalated
---

# <Task>

## Goal
One paragraph: what exists when this is done.

## Decisions
- <decision> — <one-line reason> (asked | assumed)

## Todo
- [ ] <step>
- [ ] <step>

## Verification
- `<runnable command>` (typecheck, tests, lint — whatever proves it works)
```

Check off todos as you complete them; append decisions the moment you make them. If the session dies, the file is the handoff.

**Design docs:** if a design doc exists for the touched system (`thoughts/*/design-docs/<system-slug>.md`), read it and abide — don't violate its Invariants or Boundaries; flag conflicts to the user instead of coding around them (see `desplega:design-docs`).

## Step 3: Implement

Work the todo list. Route any spawned sub-agents per `desplega:delegate-work`; hold code to the `desplega:engineering-standards` bar. Keep the plan file in sync as you go.

## Step 4: Verify

Run every command in the Verification section. All must pass. Fix and re-run — never report done with a failing check.

## Step 5: Quick code review

Run `desplega:code-reviewing` on the diff. Spec sources: the yolo plan **plus** any design doc for the touched system — pass both to the Spec agent; the doc's Invariants bind even when the yolo plan doesn't restate them. Fix Critical and Important findings, note Minor ones in the plan file.

## Step 6: Commit

Commit with a concise message referencing the change (only if the user hasn't said they handle commits themselves). Then report: what shipped, verification results, review outcome, path to the yolo plan.
