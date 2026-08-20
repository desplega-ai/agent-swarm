---
date: 2026-08-19T00:00:00Z
topic: "One-shot yolo plan: agent communication style + requester adaptation"
author: taras
tags: [plan, one-shot, prompts, requester-profile]
status: complete
last_updated: 2026-08-19
last_updated_by: taras
---

# One-shot yolo plan: agent communication style + requester adaptation

Source brainstorm: `thoughts/taras/brainstorms/2026-08-19-agent-communication-style.md` (approved body inside).

## Phase 1 — Template + composites

- Register `system.agent.communication_style` in `src/prompts/session-templates.ts` after `system.agent.code_quality`. Category `system`, no variables, body = approved soul-anchored block.
- Reference it from all 5 composites: `system.session.lead`, `system.session.worker`, `system.session.worker.pi`, `system.session.lead.pi`, `system.session.worker.remote`.

**Verification:** `bun run test:root -- src/tests/prompt-template-session.test.ts`

## Phase 2 — Requester comms + gaps (a) and (b)

- `src/types.ts`: add `UserCommsPrefsSchema` ({tone, language, verbosity} all optional strings).
- New `src/utils/requester-comms.ts`: `getUserCommsPrefs(user)` parses `users.metadata.comms` safely (strings only, trimmed, undefined when empty).
- `src/http/poll.ts`:
  - `PollRequestedBySchema` gains optional `comms`.
  - Factor `buildTriggerRequestedBy(task)` (user lookup + notes + UNKNOWN sentinel + comms).
  - Attach `requestedBy` to the `task_offered` trigger (gap a) and to the pool-claim `task_assigned` trigger (same hole, same helper).
  - Direct-assign path switches to the helper (behavior preserved + comms added).
- `src/commands/runner.ts`: `Trigger.requestedBy` gains `comms`; `buildRequesterProfilePrompt` renders a comms line and fires when only comms is set.
- `task.requester.profile` template gains `{{requester_comms_section}}`.
- `src/tools/get-task-details.ts`: `requestedBy` returns role/notes/comms (gap b); output schema stays loose, no format pins.

**Verification:** `bun run test:root -- src/tests/runner-requester-profile.test.ts src/tests/prompt-template-session.test.ts src/tests/multi-runtime-registration.test.ts`

## Phase 3 — Tests + drift

- `prompt-template-session.test.ts`: bump template count 31 → 32; assert the block renders in lead, worker, both pi composites, AND `system.session.worker.remote`.
- `runner-requester-profile.test.ts`: comms rendering + comms-only gate.
- `bun run docs:openapi` (poll response schema changed) and commit `openapi.json`.

**Verification:** `bun run lint && bun run tsc:check && bun run test:root`

## Manual E2E

```bash
# Rendered prompts contain the block (QA evidence):
bun -e 'import { ensureTemplatesRegistered } from "./src/prompts/registry"; import { resolveTemplate } from "./src/prompts/resolver"; await ensureTemplatesRegistered(); for (const t of ["system.session.lead","system.session.worker.remote"]) { const r = resolveTemplate(t, { role: "x", agentId: "a-1" }); console.log(t, r.text.includes("### Communication Style")); }'
# Requester profile with comms:
bun -e 'import { buildRequesterProfilePrompt } from "./src/commands/runner"; console.log(await buildRequesterProfilePrompt({ name: "Taras", role: "CEO", comms: { tone: "casual", language: "uk", verbosity: "terse" } }));'
```
