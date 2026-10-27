---
id: step-6
name: Live Slack connection state
depends_on: [step-5]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-6: Live Slack connection state

## Overview

After this step, the Slack pane in Team chat shows the real Socket Mode state after tokens save: "Connecting to Slack…", "Connected", or "Slack did not connect" (research J12). The data comes from the existing `getSlackConnectionState()`. No new Slack API call. Step completion stays on token presence: the live state is display only.

## Changes Required:

#### 1. API: connection state in onboarding signals
**Files**: `src/be/onboarding.ts`, `src/http/onboarding.ts`
**Changes**:
- Add optional `slackConnection: z.enum(["disconnected", "connecting", "connected"])` to `OnboardingSignalsSchema` (`src/be/onboarding.ts:125-150`).
- `buildSignals()` (`src/http/onboarding.ts:32-69`) sets it from `getSlackConnectionState()` (`src/slack/connection-state.ts`) only when Slack tokens exist. Otherwise leave it out.
- Do not change `deriveState()`.

#### 2. UI: live status in the Slack pane
**Files**: `apps/ui/src/api/types.ts`, `apps/ui/src/pages/setup/steps/integrations/slack-pane.tsx` (or `pane-parts.tsx` if the connected gate lives there)
**Changes**:
- Add `slackConnection` to the UI signals type.
- Tokens saved and `connecting`: spinner + "Connecting to Slack…".
- `connected`: the existing line "Connected. Mention the bot in a channel to send a task." with the amber `done` icon (inside /setup).
- `disconnected` for more than 15 s after save: error icon + "Slack did not connect. Check both tokens and that Socket Mode is on." The fields unfold so the user can replace a token.
- While the state is `connecting`, or for 15 s after a save, poll `useOnboarding` every 3 s. Stop polling after that.

#### 3. Tests
**File**: `src/tests/onboarding.test.ts`
**Changes**: Signals omit `slackConnection` without tokens. With tokens set and `setSlackConnectionState("connected")`, `GET /api/onboarding` returns `slackConnection: "connected"`. Reset the state after the test.

### Success Criteria:

#### Automated Verification:
- [ ] Onboarding tests: `bun run test:root -- src/tests/onboarding.test.ts`
- [ ] Root typecheck: `bun run tsc:check`
- [ ] UI gates: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] API gates: `bash scripts/check-db-boundary.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] Completion rule unchanged: `git diff feat/onboarding-maya-pr1 -- src/be/onboarding.ts | grep -n "slackConnection"` shows no use inside `deriveState`

#### Automated QA:
Use the QA environment in `root.md` (restart the API after the change).
- [ ] Fake Slack tokens: the pane shows "Connecting to Slack…" and then "Slack did not connect…" within about 20 s. Screenshot `/tmp/onb-plan-qa/step6-failed.png`. `curl -s -H "Authorization: Bearer 123123" http://localhost:3313/api/onboarding | jq -r .signals.slackConnection` prints `disconnected`.
- [ ] With real dev Slack tokens (only if the operator provides them through env vars, never printed): the pane reaches "Connected". Screenshot `/tmp/onb-plan-qa/step6-connected.png`. If no real tokens are available, mark this item skipped and say so.

#### Manual Verification:
- [ ] Taras confirms the "Connected" state with the dev Slack app (#swarm-dev-2 bot) if the automated real-token run was skipped.

**Implementation Note**: Commit as `[step-6] live Slack connection state in Team chat`.
