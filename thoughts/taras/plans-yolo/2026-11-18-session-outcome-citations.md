---
date: 2026-11-18T10:39:52Z
topic: "Cite text from session outcomes"
status: done
---

# Cite text from session outcomes

## Goal

Select a passage from a Sessions outcome and cite it in the current draft. Show each excerpt above the message with a remove button. Send the excerpts as Markdown blockquotes through the existing composer.

## Decisions

- Keep the comment in the main composer (assumed from the conversation).
- Keep citations with the session draft across reloads and changes between steering and follow-up (assumed).
- Restrict selection to one outcome at a time. Quote the selected visible text (assumed).
- Support the Sessions views, including Legacy. App-defined follow-ups use their own composer contract (assumed).
- Let users activate Cite with the pointer or with C while the action is visible (assumed).
- Work on a local feature branch because the checkout began on main (assumed).

## Todo

- [x] Add the selection action and connect it to the session draft.
- [x] Render, remove, and send citations through both composer modes.
- [x] Verify the flow and review the diff.
- [x] Commit the implementation and plan.

## Verification

- `bun run test:root -- --parallel=4 apps/ui/src/components/shared/task-composer.test.tsx apps/ui/src/components/steering/steer-composer.test.tsx apps/ui/src/components/sessions/session-conversation.test.tsx apps/ui/src/lib/composer-drafts.test.ts` passed all 45 tests.
- `E2E_UI_URL=http://127.0.0.1:60314 bun run e2e:ui -- specs/sessions-v2.spec.ts --output=/tmp/session-outcome-citations-results` passed all 10 tests for their respective projects.
- `bun run e2e:ui:tsc`, `bun run --cwd apps/ui check:tokens`, `bun run check:unit-test-allowlist`, and `git diff --check` passed.
- Biome passed on all 11 changed TypeScript files.
- The dashboard typecheck reports the same 84 diagnostics on the starting commit and feature branch. They stem from the existing json-render and Zod type conflict.

## Review

- Standards found duplicated permission checks and Markdown formatting. The action now checks the rendered editor, and a helper formats the message for both send paths.
- Spec found that the Legacy view and structured output were missing. The action now covers both.
- The desktop test covers a follow-up with citations. Focused tests cover citation-only follow-up and the steering payload. Browser tests exercise the phone layout separately.

## Manual E2E

Use the seeded Sessions API and a local dashboard.

```sh
export AGENT_BROWSER_SESSION=session-outcome-cite
agent-browser open "$SESSION_URL"
agent-browser snapshot -i
agent-browser mouse move "$SELECTION_START_X" "$SELECTION_Y"
agent-browser mouse down left
agent-browser mouse move "$SELECTION_END_X" "$SELECTION_Y"
agent-browser mouse up left
agent-browser snapshot -i
agent-browser click "$CITE_REF"
agent-browser snapshot -i
agent-browser close
```

Verified the pointer action in Sessions and the C shortcut in Legacy. Both put the selected text in the draft and focus the composer.
