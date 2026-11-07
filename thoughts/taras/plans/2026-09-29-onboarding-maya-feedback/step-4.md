---
id: step-4
name: PR 1 gate
depends_on: [step-1, step-2, step-3]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: PR 1 gate

## Overview

After this step, PR 1 is open on GitHub from branch `feat/onboarding-maya-pr1`. It carries the research doc, this plan, and steps 1-3. It has a walkthrough recording and screenshots of the new order, and the full local gate passes.

## Changes Required:

#### 1. Full gate on the PR 1 branch
**Files**: none (verification only)
**Changes**: Run every command in Automated Verification below. Fix failures in the owning step's files and commit the fix as `[step-N] fix: <what>`.

#### 2. Walkthrough evidence
**Files**: none in the repo. Evidence goes to agent-fs.
**Changes**: Record a walkthrough of the new order on the QA environment (`root.md`) with `agent-browser`, per `LOCAL_TESTING.md` section "When you need to verify a UI change" (`:456`):
- Connect (telemetry note) → AI Providers (billing chips, secret preview) → Agents (dial copy) → Memory → Integrations (Slack name field, "Skip Slack?" dialog) → Identity (new copy) → First task.
- One desktop recording (`/tmp/onb-plan-qa/pr1-walk.mp4`, re-encoded at 1.5x) and screenshots at desktop and 390 px width.
- Upload with `agent-fs write qa/agent-swarm/2026-09-29-onboarding-pr1/<name> --file <local>` and `agent-fs signed-url <path> --json --expires-in 604800`. If agent-fs is unavailable, list the local paths in the PR body and say the upload was skipped.

#### 3. Open PR 1
**Files**: `/tmp/onb-plan-qa/pr1-body.md` (not committed)
**Changes**:
- Title: `feat(onboarding): reorder /setup and sharpen step copy`
- Body follows `.github/pull_request_template.md`. Intent: paraphrase only, for example "A reviewer found that /setup asks for configuration before it shows value, and leads with a non-core step." Name no person, quote no private conversation, and link no meeting note. `src/utils/pr-body-leaks.ts` catches private-chat quotes, Slack, swarm, and agent-fs references, but not names: that part is on you. The research doc in `thoughts/` ships in the PR, so a repo-relative path to it is fine. Decisions & trade-offs: Identity after Integrations (name field moved into the Slack pane), Slack skip confirm, no benchmark claim in dial copy. No migrations, no new config keys, no breaking change (`?step=N` numbers shift, `?step=<id>` still works). Urgency: "nice to have" (the request gave none).
- `bun scripts/check-pr-body.ts --title "<title>" --body-file /tmp/onb-plan-qa/pr1-body.md`, then `gh pr create --title "<title>" --body-file /tmp/onb-plan-qa/pr1-body.md`.
- Push with `ANTHROPIC_API_KEY= OPENROUTER_API_KEY= DEEPSEEK_API_KEY= OPENAI_API_KEY= git push -u origin feat/onboarding-maya-pr1`.

#### 4. Branch for PR 2
**Changes**: `git switch -c feat/onboarding-maya-pr2` from the PR 1 branch tip. Steps 5-10 commit here. PR 2 targets `feat/onboarding-maya-pr1` until PR 1 merges.

### Success Criteria:

#### Automated Verification:
- [ ] Root typecheck: `bun run tsc:check`
- [ ] Root lint: `bun run lint`
- [ ] Onboarding tests: `bun run test:root -- src/tests/onboarding.test.ts`
- [ ] UI gates: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] UI smoke: `bun run e2e:ui -- --grep @smoke`
- [ ] PR body check: `bun scripts/check-pr-body.ts --title "feat(onboarding): reorder /setup and sharpen step copy" --body-file /tmp/onb-plan-qa/pr1-body.md`
- [ ] PR exists: `gh pr view feat/onboarding-maya-pr1 --json url -q .url` prints a URL
- [ ] CI is green: `gh pr checks feat/onboarding-maya-pr1` shows no failure (re-run once for a known flaky job, then report)

#### Automated QA:
- [ ] The recording plays and covers all 7 steps in the new order.
- [ ] The PR body embeds the screenshots and the recording link (or the local paths with a "skipped upload" note).

#### Manual Verification:
- [ ] Taras reviews PR 1 before steps 5-10 start.

**Implementation Note**: This is a stitch-and-ship step. Commit only fixes. Stop after the PR is open and wait for Taras before the PR 2 lanes start.
