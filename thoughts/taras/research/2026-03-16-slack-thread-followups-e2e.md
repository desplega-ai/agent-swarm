---
date: 2026-03-16T12:00:00Z
topic: "Slack Thread Follow-Up Fixes — E2E Test Results"
branch: fix/slack-thread-followups
commit: f1d2147
---

# E2E: Slack Thread Follow-Up Fixes

## Setup

- Clean DB + API server (`bun run start:http`) + single Docker lead (`.env.docker-lead` + `AGENT_ROLE=lead`)
- No workers — lead-only setup
- `ADDITIVE_SLACK=true` in `.env`

## Test Results

### Test 1: Thread follow-up WITHOUT @mention (Phase 1 fix)
- [x] @mention bot in channel thread: `@bot say hello`
- [x] Wait for lead to respond
- [x] Send follow-up WITHOUT @mention: `Now say goodbye`
- [x] Lead picks it up (not silently dropped)
- **Channel:** `C0A4BSMEE7`

### Test 2: parentTaskId linking (Phase 2)
- [x] First task (`1547e2dc`) has `parentTaskId=none` (root)
- [x] Second task (`7012e058`) has `parentTaskId=1547e2dc`
- [x] Third task (`1453cece`) has `parentTaskId=7012e058`
- [x] Chain is correct — each follow-up links to previous task

### Test 3: DM thread follow-ups (Phase 2)
- [x] Send DM to bot: `say hi`
- [x] Wait for response
- [x] Send follow-up in same DM thread
- [x] Follow-up task has `parentTaskId` linking to previous
- **Channel:** `D0AKYSSHR0`
- **Chain:** `981eda42` -> `f1fa5757` -> `775498ac`

### Test 4: Additive buffer follow-ups (Phase 2, ADDITIVE_SLACK=true)
- [x] DM follow-ups went through buffer path
- [x] `parentTaskId` correctly set on buffered tasks

### Not tested (no workers in setup)
- [ ] Worker task notifications in Slack thread (Phase 3 — watcher query widening)
  - Requires a worker to delegate to and complete a task
  - Unit tests cover the query change; manual verification deferred

## Verdict

**All tested scenarios pass.** The 4 interacting issues identified in the plan are fixed:
1. Thread follow-ups no longer silently dropped when agent offline
2. Session continuity via `parentTaskId` on all follow-up paths
3. Watcher queries widened (unit-tested, not E2E-tested without workers)
4. Prompt guidance added for lead delegation
