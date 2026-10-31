---
id: step-11
name: PR 2 gate
depends_on: [step-7, step-8, step-9, step-10]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-11: PR 2 gate

## Overview

After this step, PR 2 is open from `feat/onboarding-maya-pr2`, stacked on PR 1. The OpenAPI spec is regenerated once, the telemetry docs describe the two new events, the full gate passes, and a walkthrough recording covers the whole new flow.

## Changes Required:

#### 1. Regenerate OpenAPI
**Files**: `openapi.json`, `docs-site/content/docs/api-reference/**`, `docs-site/public/openapi.d.ts`
**Changes**: `bun run docs:openapi`. Commit all generated files as `[step-11] regenerate OpenAPI`.

#### 2. Telemetry docs
**File**: `docs-site/content/docs/(documentation)/reference/telemetry.mdx`
**Changes**: The event table is generated. Run `bun run build:telemetry-docs` and commit any change (step 8 should already have done it after the catalog sync). Outside the generated block, add one short paragraph: the /setup waitlist form sends the email to Desplega's feedback endpoint only when a user submits it, and the swarm records the PII-free `lead.captured` event (subject to `ANONYMIZED_TELEMETRY`).

#### 3. Full gate
**Changes**: Run every command in `root.md` → Global Verification. Fix failures in the owning step's files and commit as `[step-N] fix: <what>`.

#### 4. Walkthrough evidence
**Changes**: Run the `root.md` Manual E2E setup (QA environment + Docker agents). Record the whole flow with `agent-browser`: Welcome → Connect → AI Providers (subscription question) → Agents → Memory → Team chat (Slack state, Teams waitlist) → Identity (Slack preview) → Code & tools → First task. Desktop recording plus 390 px screenshots of every step. Upload to `qa/agent-swarm/2026-09-29-onboarding-pr2/` with agent-fs and signed URLs (`--expires-in 604800`). If agent-fs is unavailable, list local paths and say the upload was skipped.

#### 5. Open PR 2
**Files**: `/tmp/onb-plan-qa/pr2-body.md` (not committed)
**Changes**:
- Title: `feat(onboarding): Team chat step, Slack preview, subscription question, and welcome screen`
- Base: `feat/onboarding-maya-pr1` (`gh pr create --base feat/onboarding-maya-pr1 ...`). Retarget to `main` after PR 1 merges.
- Body per `.github/pull_request_template.md`. Intent: paraphrase only ("a reviewer asked for ..."). Name no person, quote no private conversation, and link no meeting note. `src/utils/pr-body-leaks.ts` catches private-chat quotes, Slack, swarm, and agent-fs references, but not names: that part is on you. Decisions & trade-offs must list: new step id `chat` (no migration, back-filled), the new `subscriptions` field in onboarding state, the new `POST /api/onboarding/lead` route, the catalog sync for `onboarding.subscriptions_answered` (with the proxy PR link), and the waitlist email path (browser → proxy feedback endpoint, never through the API). Urgency: "nice to have".
- `bun scripts/check-pr-body.ts --title "<title>" --body-file /tmp/onb-plan-qa/pr2-body.md`, then `gh pr create`.
- Push with `ANTHROPIC_API_KEY= OPENROUTER_API_KEY= DEEPSEEK_API_KEY= OPENAI_API_KEY= git push -u origin feat/onboarding-maya-pr2`.

### Success Criteria:

#### Automated Verification:
- [ ] OpenAPI is fresh: `bun run docs:openapi && git diff --exit-code openapi.json docs-site/public/openapi.d.ts`
- [ ] Every command in `root.md` → Global Verification passes
- [ ] Telemetry docs are current: `bun run check:telemetry-docs && grep -c "subscriptions_answered\|lead.captured" "docs-site/content/docs/(documentation)/reference/telemetry.mdx"` prints `2` or more
- [ ] PR exists with the right base: `gh pr view feat/onboarding-maya-pr2 --json baseRefName -q .baseRefName` prints `feat/onboarding-maya-pr1`
- [ ] CI is green: `gh pr checks feat/onboarding-maya-pr2` shows no failure (re-run once for a known flaky job, then report)

#### Automated QA:
- [ ] The recording covers all 9 screens (welcome + 8 steps) in order.
- [ ] The PR body embeds the screenshots and the recording link (or local paths with a "skipped upload" note).

#### Manual Verification:
- [ ] Taras runs the `root.md` Manual E2E checklist and reviews PR 2.

**Implementation Note**: Stitch-and-ship step. Commit only the regenerated files, the docs change, and fixes.
