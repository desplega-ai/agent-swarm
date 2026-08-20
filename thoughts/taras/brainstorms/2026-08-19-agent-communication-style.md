---
date: 2026-08-19T00:00:00+02:00
author: taras
topic: "system.agent.communication_style prompt template + requester mirroring"
tags: [brainstorm, prompts, communication, requester-profile]
status: complete
exploration_type: idea
last_updated: 2026-08-19
last_updated_by: taras
---

# system.agent.communication_style template — Brainstorm

## Context

Swarm agents should communicate in a more human, direct style and adapt to the requester.

Verified facts (from prior research, spot-checked in this repo):

- `getBasePrompt()` (src/commands/runner.ts) composes every agent session prompt from 5 composite templates in `src/prompts/session-templates.ts`:
  `system.session.lead` (line 848), `system.session.worker` (870), `system.session.worker.pi` (898), `system.session.lead.pi` (927), `system.session.worker.remote` (980).
- All human-facing output (internal/external Slack, gh/glab comments, Linear/Jira wrappers around store-progress, email, pages) is agent-authored under that prompt. One style block reaches every surface.
- Requester adaptation partly exists: `task.requester.profile` template (line 810) renders users.role + users.notes via `buildRequesterProfilePrompt` (runner.ts:2614). Gaps:
  (a) it only fires on `task_assigned`; `task_offered` carries no `requestedBy`,
  (b) `get-task-details` returns only name/email,
  (c) no structured tone/language/verbosity fields; `users.metadata` JSON exists but nothing reads it.
- Style-rule sources: `~/.agents/skills/asd-ste100/SKILL.md` (structural rules: sentence length caps, active voice, one idea per sentence, no semicolons, hedge preservation, no marketing adjectives) and `~/.agents/skills/comms/SKILL.md`.

Goals for this brainstorm:

1. Exact body of the new `system.agent.communication_style` template (~15 lines, ships in every system prompt).
2. One requester-mirroring line: reply in the requester's language, match register, answer at the depth asked.
3. Decide: ship structured `users.metadata.comms` {tone, language, verbosity} now, or defer to a second PR.

## Exploration

### Q: Ship structured users.metadata.comms {tone, language, verbosity} in this PR, or defer to a second PR?
Ship now (full stretch): read `users.metadata.comms` in `buildRequesterProfilePrompt`, AND close gap (a) `task_offered` carries no `requestedBy`, AND close gap (b) `get-task-details` returns only name/email.

**Insights:** Taras wants the full requester-adaptation loop in one PR, even though nothing writes `users.metadata.comms` yet. Fields render only when set, so an empty metadata blob is a no-op.

### Q: Which template body ships?
First draft (mechanical rules only) prompted: "should we reference soul or something?" Checked the code: agents already have a `soulMd` field (one of six identity blobs: claudeMd/soulMd/identityMd/toolsMd/heartbeatMd/setupScript). It is inlined into the system prompt under `## Your Identity` (src/prompts/base-prompt.ts:233) and materialized to `/workspace/SOUL.md` (runner.ts:5219, update-profile.ts:315). Default soul content (`generateDefaultSoulMd`, src/prompts/defaults.ts:56) already pushes "skip the pleasantries" and "don't sugarcoat blockers".

**Approved body** (soul-anchored full block, ~15 lines):

```
### Communication Style

Your persona lives in your SOUL.md (see Your Identity, when present). It defines who you are. The rules below define how you write, whoever you are.

They govern everything a human reads from you: Slack, PR and issue comments, tickets, email, pages, and task summaries.

- Write like a person, not a press release. Plain words, direct statements.
- Lead with the outcome or the answer. Context comes after.
- Keep sentences short (25 words or fewer). One idea per sentence.
- Use active voice. Say who did what.
- Never use em dashes. Use a period, a comma, a colon, or parentheses.
- No marketing adjectives (seamless, robust, powerful). State the fact that earns the claim instead.
- No hedge stacks ("might possibly perhaps"). Keep a hedge only when you are genuinely unsure, and keep it: "may have failed" never becomes "failed".
- No filler ("I hope this helps", "Great question!") and no formal sign-offs.
- If something is broken, blocked, or a bad idea, say so plainly and say why.
- Mirror the requester: reply in the language they wrote in, match their register, and answer at the depth they asked. A one-line question gets the answer first, detail after.
- If a Requester Profile section is present, it wins on tone, depth, and format. Correctness always wins over style.
```

**Insights:** Remote providers get a simplified identity WITHOUT soulMd (base-prompt.ts:211-223), so the soul reference is phrased conditionally ("when present"). Precedence chain: correctness > requester profile (tone/depth/format) > soul persona > style defaults.

## Synthesis

### Key Decisions
- Register `system.agent.communication_style` in `src/prompts/session-templates.ts` near `system.agent.code_quality` (~line 776), with the approved body above. Category: `system`, no variables.
- Reference it from ALL 5 composites: `system.session.lead`, `system.session.worker`, `system.session.worker.pi`, `system.session.lead.pi`, and `system.session.worker.remote` (do not miss remote). In the 4 big composites it sits next to `share_urls`/`code_quality`; in `worker.remote` it is appended after `system.agent.worker.remote`.
- Ship `users.metadata.comms` {tone, language, verbosity} NOW (full stretch): read it in `buildRequesterProfilePrompt` and render into `task.requester.profile`.
- Close gap (a): `task_offered` (src/http/poll.ts:279) must carry `requestedBy` like `task_assigned` does.
- Close gap (b): `get-task-details` (src/tools/get-task-details.ts:191-195) returns requester role, notes, and comms alongside name/email.
- Deferred: per-agent soul authoring improvements (default soul already covers persona; no change to `generateDefaultSoulMd` in this PR).
- Deferred: any write path / UI for `users.metadata.comms` — defaulting to "fields are read-only plumbing for now, set via direct DB/API metadata writes".
- Default taken: comms fields are free-form strings (not enums), trimmed, each rendered only when non-empty. No validation layer since nothing writes them yet.

### Open Questions
- How does `task_assigned` populate `requestedBy` in src/http/poll.ts, so `task_offered` can reuse the same lookup? (answer during implementation)
- Does the users table expose `metadata` on the row type used by poll.ts / get-task-details, or does it need selecting? (answer during implementation)

### Constraints Identified
- Prompt text MUST go through the prompt-template registry in `src/prompts/` (CLAUDE.md invariant); no string concatenation in runners/hooks/providers.
- Remote sessions have no soulMd in the prompt; the block's soul reference must not assume it.
- `get-task-details` output schema rules: loose object, all data fields optional, no format pins on output (SwarmToolResult contract).
- Per-session token cost of the block is ~150 tokens x every session; acceptable.

### Core Requirements
1. New `system.agent.communication_style` template, exact approved body, referenced by all 5 session composites.
2. Requester mirroring line ships inside the block (language, register, depth).
3. `buildRequesterProfilePrompt` reads `users.metadata.comms` {tone, language, verbosity} and renders them in the requester profile section.
4. `task_offered` payload carries `requestedBy` (gap a).
5. `get-task-details` returns requester role/notes/comms (gap b).
6. QA evidence: rendered lead prompt AND rendered worker.remote prompt contain the new block; typecheck + existing tests pass.

## Next Steps

- Handoff to `/desplega:one-shot` (yolo plan + implement), then `/desplega:qa`. Prescribed by Taras at session start.
