---
id: step-1
name: Flow order, step copy, Slack skip confirm, name in Slack pane
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: Flow order, step copy, Slack skip confirm, name in Slack pane

## Overview

After this step, /setup runs in the order **Connect → AI Providers → Agents → Memory → Integrations → Identity → First task**. Every step title and description states its payoff (research J3, J8). The Identity copy no longer claims logo and color reach Slack (F1). Skipping Integrations while Slack is not connected opens a "Skip Slack?" confirm (J14). The Slack pane has its own swarm-name field, because the manifest needs the name before Identity runs.

File ownership (no other PR 1 step touches these): `apps/ui/src/api/hooks/use-onboarding.ts`, `apps/ui/src/pages/setup/page.tsx`, `apps/ui/src/pages/setup/steps/integrations/slack-pane.tsx`.

## Changes Required:

#### 1. Step order
**File**: `apps/ui/src/api/hooks/use-onboarding.ts`
**Changes**: Reorder `ONBOARDING_STEPS` (`:18-26`) to `connect, ai, agents, memory, integrations, name, first_task`. Keep ids and labels. No API change: the API is keyed by id (`src/be/onboarding.ts:10-18` is membership only).

#### 2. Step copy with a payoff per step
**File**: `apps/ui/src/pages/setup/page.tsx`
**Changes**: Rewrite `STEP_COPY` (`:46-75`). Each description says what the user gets. Draft copy (polish is fine, keep it one or two short sentences, verb-first, no em dashes):
- `connect`: keep as is (PR 3 changes it).
- `ai`: "Choose the AI your agents run on" / "Use the plans you already pay for. One verified provider is enough to start."
- `agents`: "Pick a model for each agent" / "Optimal is our pick for most swarms. Change any agent later."
- `memory`: "Turn on memory" / "Agents recall what earlier tasks learned, so they stop repeating work."
- `integrations`: "Connect your tools" / "Your team hands the swarm work in Slack. The swarm works in your repos."
- `name`: "Give your swarm an identity" / "Slack shows the name. The mark and color style the dashboard and pages." (F1: only the name reaches Slack.)
- `first_task`: keep as is.

Add `SKIP_HINT.integrations`: "Your team can't reach the swarm from Slack until you connect it."

#### 3. "Skip Slack?" confirm
**File**: `apps/ui/src/pages/setup/page.tsx`
**Changes**: When `stepId === "integrations"` and `onboarding.signals.integrations.slack` is false, the footer Skip (button and `S` shortcut) opens a controlled `AlertDialog` instead of calling `skip()` (`page.tsx:349-359`). Follow `apps/ui/src/pages/config/components/swarm-config-section.tsx:222-239`.
- Title: "Skip Slack?"
- Description: "Your team reaches the swarm in Slack: mention it in a channel to hand out work. You can connect Slack later in Settings."
- Cancel (default focus): "Connect Slack". Closes the dialog and stays on the step.
- Action: "Skip for now". Calls the existing `skip(stepId)`.
- With Slack connected, Skip works as today. Setup shortcuts already pause while an `alertdialog` is open (`setup-footer.tsx:148-156`).

#### 4. Swarm name in the Slack pane
**File**: `apps/ui/src/pages/setup/steps/integrations/slack-pane.tsx`
**Changes**: In `SlackAppActions` (`:56-116`), add an autosaving "Name in Slack" text field bound to `SWARM_ORG_NAME`.
- Reuse the Identity step pattern: `useSetupSave()` (`apps/ui/src/components/onboarding/use-setup-save.ts`) + `useAutosave` (see `step-name.tsx:~119`). Initial value from `initialSwarmName()` (`apps/ui/src/pages/setup/components/swarm-name.ts:18-23`).
- Hint: "Up to 35 characters. Slack shows this as the app name." (`manifestName()` cuts at 35, `src/slack/manifest.ts:5-6`.)
- The manifest query (`:56-67`) keys on the saved name, so "Copy manifest" and "Copy setup prompt" carry it.
- Honest states per the dashboard-ui rules: "Saving…", then "Saved", or the server error.

### Success Criteria:

#### Automated Verification:
- [ ] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] Root typecheck passes: `bun run tsc:check`
- [ ] Onboarding API tests still pass: `bun run test:root -- src/tests/onboarding.test.ts`
- [ ] Order is right: `grep -A8 "ONBOARDING_STEPS" apps/ui/src/api/hooks/use-onboarding.ts | grep -o 'id: "[a-z_]*"' | tr '\n' ' '` prints `id: "connect" id: "ai" id: "agents" id: "memory" id: "integrations" id: "name" id: "first_task"`
- [ ] F1 copy is gone: `grep -c "in Slack, and on pages" apps/ui/src/pages/setup/page.tsx` prints `0`
- [ ] No em dashes added: `git diff -U0 -- apps/ui | grep '^+' | grep -c "$(printf '\342\200\224')"` prints `0`

#### Automated QA:
Use the QA environment in `root.md`.
- [ ] The stepper shows Connect, AI Providers, Agents, Memory, Integrations, Identity, First task, in that order. Screenshot: `agent-browser screenshot /tmp/onb-plan-qa/step1-stepper.png`
- [ ] `?step=5` opens Integrations, and Continue from Integrations lands on Identity.
- [ ] On Integrations with no Slack tokens, pressing `S` opens "Skip Slack?". "Connect Slack" keeps the step. "Skip for now" marks integrations `skipped` (`curl -s -H "Authorization: Bearer 123123" http://localhost:3313/api/onboarding | jq -r .state.steps.integrations.status` prints `skipped`) and lands on Identity.
- [ ] Typing a name in the Slack pane saves it: after about 1 s, `curl -s -H "Authorization: Bearer 123123" "http://localhost:3313/api/config/resolved?key=SWARM_ORG_NAME" | jq` shows the new value, and the Identity step shows the same name.
- [ ] Phone width (390 px): the dialog and the Slack name field fit with no horizontal scroll. Screenshot `/tmp/onb-plan-qa/step1-phone.png`.

#### Manual Verification:
- [ ] Taras reads the new step copy and approves the wording.

**Implementation Note**: Commit only the three owned files as `[step-1] reorder /setup, payoff copy, Slack skip confirm, name in Slack pane`. Pause for Taras's copy check before step 4.
