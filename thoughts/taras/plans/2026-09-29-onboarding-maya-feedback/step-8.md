---
id: step-8
name: What do you pay for? + card reorder + mismatch notes
depends_on: [step-6]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-8: What do you pay for? + card reorder + mismatch notes

## Overview

After this step, AI Providers opens with one question: "What do you already pay for?" (research J5). The answer reorders the provider cards (never hides one: Taras's decision), opens the best match, and shows mismatch notes where an option cannot use the chosen plan. The answer persists in onboarding state and goes to telemetry as anonymous booleans.

This step crosses repos. Telemetry events must exist in the vendored catalog from the private `desplega-ai/proxy` repo (see `root.md`, "Telemetry (after #1780)"). Work order inside the step: open the proxy PR first (part 0), build parts 1, 3, and 4 while Taras reviews it, then wire the event after the merge (part 2).

## Changes Required:

#### 0. Proxy catalog PR (blocks part 2)
**Repo**: `desplega-ai/proxy` (private), file `contracts/telemetry/catalog/events.json`
**Changes**:
- `gh repo clone desplega-ai/proxy /tmp/onb-plan-proxy && cd /tmp/onb-plan-proxy && git switch -c feat/onboarding-subscriptions-answered`
- Add event `onboarding.subscriptions_answered`: product `agent-swarm`, source `api-server`, description "The operator answered which AI plans they already pay for during /setup.", properties `has_claude`, `has_chatgpt`, `has_devin`, `has_openrouter`, `api_keys_only` (boolean, required). Copy the shape of the existing `onboarding.*` entries (vendored copy: `src/telemetry-contract/catalog.json:844-1000` in agent-swarm).
- Run the proxy repo's own generators and checks (read its README or CLAUDE.md first), then open the PR with `gh pr create`.
- Stop and ask Taras to review and merge the proxy PR. Record the merge commit sha.

#### 1. API: persist the answer
**File**: `src/be/onboarding.ts`
**Changes**:
- `SubscriptionIdSchema = z.enum(["claude", "chatgpt", "devin", "openrouter", "api_keys"])`.
- Optional `subscriptions: { values: SubscriptionId[], at: string } | null` on `OnboardingStateSchema`. `freshState()` sets `null`. `parseStoredState()` accepts blobs without it.
- New action variant `{ action: "subscriptions", values: SubscriptionId[] }` (0 to 5 values, unique). It writes the field. The telemetry call comes in part 2.

#### 2. Wire the event (after the proxy merge)
**Files**: `src/telemetry-contract/*` (vendored, generated), `docs-site/content/docs/(documentation)/reference/telemetry.mdx` (generated table), `src/be/onboarding.ts`
**Changes**:
- `bun run sync:telemetry-contract <proxy-merge-sha>`, then `bun run build:telemetry-docs`. Commit the vendored files and the docs. Never hand-edit them.
- Extend `OnboardingTelemetryEvent` / `OnboardingTelemetryProperties` (`src/be/onboarding.ts:254-285`) and queue `subscriptions_answered` from the new action through `queueTelemetry()` (`:364-371`). Skip it when `autoCompleted`, like the other funnel events. `tsc` rejects the call until the sync lands.

#### 3. UI: the question and the reorder
**Files**: `apps/ui/src/api/types.ts`, `apps/ui/src/pages/setup/steps/step-ai.tsx`, `apps/ui/src/pages/setup/steps/ai/*` (new `subscription-question.tsx`, `model.ts` for the order logic)
**Changes**:
- Multi-select chip group at the top of the step: "Claude Pro or Max", "ChatGPT Plus or Pro", "Devin", "OpenRouter credits", "None, I'll use API keys". "None" clears the others, and any other choice clears "None".
- Autosave: send the action about 800 ms after the last change. Honest states ("Saving…", "Saved", or the error).
- Card order (`step-ai.tsx:112-115` becomes data-driven in `ai/model.ts`): matching cards first, then the rest in today's order. Mapping: `claude` → Claude card, `chatgpt` → Codex card, `devin` → Devin card, `openrouter` → open-harness card. `api_keys` or no answer → today's order. The first matching card opens.
- Mismatch notes, one short line on the affected card:
  - Open-harness card when the answer has `claude` or `chatgpt` but not `openrouter`: "These harnesses bill per token. They do not use your Claude or ChatGPT plan."
  - Devin card when the answer lacks `devin`: "Needs a Devin plan."
  - `api_keys` selected: a note under the question: "Plans usually cost less at swarm volume. Usage shows your savings." with a `setupExitHref()` link to the Usage page (new tab).
- Verify every mismatch claim against `docs-site/content/docs/(documentation)/guides/harness-providers.mdx` and `src/providers/*` before you write it. Drop any note the code does not support, and say so in the commit message.

#### 4. Tests
**File**: `src/tests/onboarding.test.ts`
**Changes**: The action stores the values and `at`. It rejects unknown ids and duplicates. An old blob without `subscriptions` parses as `null`. The telemetry queue gets one `subscriptions_answered` event with the booleans, and none for an auto-completed install.

Do not regenerate `openapi.json` here. Step 11 does it once.

### Success Criteria:

#### Automated Verification:
- [ ] Proxy PR exists: `gh pr list --repo desplega-ai/proxy --head feat/onboarding-subscriptions-answered --state all --json url -q '.[0].url'` prints a URL
- [ ] Vendored contract has the event: `grep -c '"subscriptions_answered"' src/telemetry-contract/catalog.json` prints `1` or more
- [ ] Telemetry contract and docs: `bun run check:telemetry-contract && bun run check:telemetry-docs`
- [ ] Onboarding tests: `bun run test:root -- src/tests/onboarding.test.ts`
- [ ] Root typecheck: `bun run tsc:check`
- [ ] UI gates: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] API gates: `bash scripts/check-db-boundary.sh && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
Use the QA environment in `root.md` (restart the API after the change).
- [ ] Select "Claude Pro or Max" and "ChatGPT Plus or Pro": after about 1 s, `curl -s -H "Authorization: Bearer 123123" http://localhost:3313/api/onboarding | jq -c .state.subscriptions.values` prints `["claude","chatgpt"]`.
- [ ] The Claude and Codex cards sit first, the Claude card is open, and the open-harness card shows its mismatch note. Screenshot `/tmp/onb-plan-qa/step8-order.png`.
- [ ] Select "None, I'll use API keys": the other chips clear, the order returns to default, and the savings note links to Usage in a new tab. Screenshot `/tmp/onb-plan-qa/step8-api.png`.
- [ ] Reload: the answer and the order persist.
- [ ] Phone width (390 px): chips wrap. Screenshot `/tmp/onb-plan-qa/step8-phone.png`.

#### Manual Verification:
- [ ] Taras reviews and merges the `desplega-ai/proxy` catalog PR (part 0).
- [ ] Taras approves the chip labels and the mismatch wording.

**Implementation Note**: Two commits: `[step-8] subscription question, card order, mismatch notes` (parts 1, 3, 4 without the event), then `[step-8] wire onboarding.subscriptions_answered after proxy catalog sync` (part 2). If the proxy merge is slow, finish parts 1, 3, and 4 and pause the step with status `ready`, noting what is left.
