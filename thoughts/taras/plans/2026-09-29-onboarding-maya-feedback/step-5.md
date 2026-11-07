---
id: step-5
name: Team chat step (new chat id)
depends_on: [step-4]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: Team chat step (new `chat` id)

## Overview

After this step, /setup has a "Team chat" step between Memory and Identity, and Integrations becomes "Code & tools" after Identity (research J15, J16). Order: **Connect → AI Providers → Agents → Memory → Team chat → Identity → Code & tools → First task.**

Team chat opens with the multiplayer pitch and lists where a team can talk: Slack (the existing pane, moved here), Microsoft Teams, WhatsApp, and "Something else". This step builds the list and the Slack move. Teams and "Something else" show a placeholder row ("Coming soon") that step 10 turns into a waitlist form. WhatsApp links to the existing Kapso setup in Settings.

Team chat is done when Slack tokens exist (same presence rule as today). Code & tools is done when GitHub, GitLab, Linear, or Jira connects. Slack alone no longer completes it.

Branch: `feat/onboarding-maya-pr2`.

## Changes Required:

#### 1. API: new step id and split completion
**File**: `src/be/onboarding.ts`
**Changes**:
- Add `chat` to `OnboardingStepIdSchema` (`:10-18`).
- Add `OnboardingChatMethodSchema = z.enum(["slack"])`, its step-state schema (`~:92-102`), the `chat` key in `OnboardingStateSchema.steps` (`:113-121`) and `freshState()` (`:300-320`), a `complete` variant for `chat` (`:159-194`), and `chat` in the hand-listed `skip` enum (`:195-200`).
- Keep `slack` in `OnboardingIntegrationMethodSchema` (`:57-63`) so old persisted blobs still parse. `inferIntegrationMethod()` (`:477-486`) must stop returning `slack`: it checks `github, gitlab, linear, jira` only.
- New `inferChatMethod()` returns `slack` when `signals.integrations.slack` is true. `deriveState()` (`~:488-510`) completes `chat` and `integrations` independently.
- `parseStoredState()` (`:326-346`) already back-fills the new id as `todo`. An old install whose `integrations` step is `done` with method `slack` keeps it done.

#### 2. UI: step list, copy, icons, checklist
**Files**: `apps/ui/src/api/hooks/use-onboarding.ts`, `apps/ui/src/api/types.ts`, `apps/ui/src/pages/setup/page.tsx`, `apps/ui/src/pages/setup/components/setup-stepper.tsx`, `apps/ui/src/components/onboarding/setup-checklist-card.tsx`
**Changes**:
- `ONBOARDING_STEPS`: `connect, ai, agents, memory, chat ("Team chat"), name, integrations ("Code & tools"), first_task`.
- UI types: add `chat` to the step-id union and state, and the `complete` action variant.
- `STEP_COPY.chat`: "Bring the swarm to your team" / "The swarm is multiplayer. Your team hands it work where you already talk." `STEP_COPY.integrations`: "Connect your code and tools" / "The swarm works in your repos and your trackers."
- Move the step-1 "Skip Slack?" confirm and `SKIP_HINT` entry from `integrations` to `chat`.
- `STEP_BODIES.chat` = new `StepChat`. `STEP_ICON.chat` = `MessagesSquare` (lucide).
- `stepSubtitle()` gets a `chat` case: "Slack connected" or "Not connected". The `integrations` case lists only code and tool connections.

#### 3. UI: Team chat step body
**File**: `apps/ui/src/pages/setup/steps/step-chat.tsx` (new), `apps/ui/src/pages/setup/steps/chat/*` (new, if the body needs parts)
**Changes**:
- Rows, in order: Slack (recommended chip, `info` tone), Microsoft Teams, WhatsApp, Something else. Follow the row and pane pattern of `step-integrations.tsx`.
- Slack expands to the existing `SlackPane` (`apps/ui/src/pages/setup/steps/integrations/slack-pane.tsx`, with the step-1 name field). Keep the Slack token fields and `SLACK_MODE=socket` writes from `catalog.ts:236-252`.
- Teams and "Something else": a "Coming soon" row with a placeholder slot named `WaitlistSlot` that step 10 replaces. No form in this step.
- WhatsApp: "Available through Kapso." plus a "Set up in Settings" link built with `setupExitHref()` to the Settings integrations page (new tab).
- The step self-completes from `signals.integrations.slack`, like `step-integrations.tsx:87-94` does today.

#### 4. UI: Code & tools regroup
**Files**: `apps/ui/src/pages/setup/steps/integrations/catalog.ts`, `apps/ui/src/pages/setup/steps/step-integrations.tsx`
**Changes**:
- Remove Slack from the Integrations groups. New groups: "Code" (GitHub, GitLab), "Work tracking" (Linear, Jira), "Business tools" (unchanged).
- `connectedMethod()` (`catalog.ts:317-322`) and the self-complete effect ignore Slack.
- Linear/Jira OAuth return (`step-integrations.tsx:34`, `:60-83`) stays on `step=integrations`.

#### 5. Tests
**File**: `src/tests/onboarding.test.ts`
**Changes**:
- Slack tokens complete `chat` with method `slack` and leave `integrations` as `todo`.
- `GITHUB_TOKEN` completes `integrations` (existing test at `:351-360`) and leaves `chat` as `todo`.
- `skip` accepts `chat`. `skip` still rejects `connect` (`:492-499`).
- An old stored blob without `chat` and with `integrations: { status: "done", method: "slack" }` parses, keeps integrations done, and derives `chat` from the Slack signal.
- Update the sequential walk (`:404-490`) to the new order and include `chat`.

Do not regenerate `openapi.json` here. Step 11 does it once.

### Success Criteria:

#### Automated Verification:
- [ ] Onboarding tests: `bun run test:root -- src/tests/onboarding.test.ts`
- [ ] Root typecheck: `bun run tsc:check`
- [ ] Root lint: `bun run lint`
- [ ] UI gates: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] API gates: `bash scripts/check-db-boundary.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] Order: `grep -A10 "ONBOARDING_STEPS" apps/ui/src/api/hooks/use-onboarding.ts | grep -o 'id: "[a-z_]*"' | tr '\n' ' '` prints `id: "connect" id: "ai" id: "agents" id: "memory" id: "chat" id: "name" id: "integrations" id: "first_task"`

#### Automated QA:
Use the QA environment in `root.md` (restart the API after the schema change).
- [ ] The stepper shows 8 steps in the new order. Screenshot `/tmp/onb-plan-qa/step5-stepper.png`.
- [ ] Team chat lists Slack, Microsoft Teams, WhatsApp, Something else. Screenshot `/tmp/onb-plan-qa/step5-chat.png`.
- [ ] Saving fake Slack tokens (`xoxb-` and `xapp-` values of valid length) marks `chat` done: `curl -s -H "Authorization: Bearer 123123" http://localhost:3313/api/onboarding | jq -r '.state.steps.chat.status, .state.steps.integrations.status'` prints `done` then `todo`.
- [ ] Skip on Team chat without Slack opens "Skip Slack?". Skip on Code & tools does not.
- [ ] The WhatsApp link opens Settings in a new tab with `fromSetup=1` in the URL.
- [ ] Home checklist (`/`) shows 8 rows with the chat subtitle. Screenshot `/tmp/onb-plan-qa/step5-checklist.png`.
- [ ] Phone width (390 px): Team chat rows fit. Screenshot `/tmp/onb-plan-qa/step5-phone.png`.

#### Manual Verification:
- [ ] Taras approves the Team chat pitch copy.

**Implementation Note**: Commit the files listed above as `[step-5] Team chat step, Code & tools regroup`.
