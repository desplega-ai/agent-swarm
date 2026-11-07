---
id: step-7
name: Identity Slack preview
depends_on: [step-4]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-7: Identity Slack preview

## Overview

After this step, the Identity step shows how the swarm looks in Slack, next to the existing sidebar preview (research J9, F1). The preview uses the same persona rules Slack posts use: each agent's name and emoji, and the app name from the manifest. A caption says the mark and color stay in the dashboard.

## Changes Required:

#### 1. API: preview data from the real persona helpers
**Files**: `src/http/integrations.ts`, `src/slack/responses.ts`
**Changes**:
- Export a small map next to `getAgentEmoji()` (`src/slack/responses.ts:443-459`) from its 9 shortcodes (`:crown:` plus the 8 hash emoji) to Unicode characters. Keep one source: `getAgentEmoji()` stays the only place that picks the shortcode.
- New route with the `route()` factory in `src/http/integrations.ts`, next to the manifest route (`:85-95`): `GET /api/integrations/slack/preview?name=<optional>`. Response schema (zod, sent with `.respond()`):
  - `appName`: `manifestName(name)` (`src/slack/manifest.ts:5-6`, 35-char cut).
  - `personas`: up to 3 entries `{ agentId, name, emoji, isLead }`, lead first, extension agents excluded. `name` = `getAgentDisplayName()`, `emoji` = Unicode of `getAgentEmoji()`.
- GET needs no `rbac` block. The handler file is already in `src/http/all-routes.ts`.
- Do not regenerate `openapi.json` here. Step 11 does it once.

#### 2. UI: Slack message mock
**Files**: `apps/ui/src/api/types.ts`, `apps/ui/src/api/client.ts`, `apps/ui/src/pages/setup/steps/name/slack-preview.tsx` (new), `apps/ui/src/pages/setup/steps/step-name.tsx`
**Changes**:
- Client method + types for the preview route. Query key includes the debounced name draft, so the preview follows typing.
- `SlackPreview`: a static thread mock built from design tokens (no raw palette classes, no Slack logo):
  - A human message: "@{appName} review the open pull requests"
  - A reply from the lead persona: "{emoji} {name}" with an "APP" tag: "On it. I split this into two tasks for the team."
  - A reply from a second persona if one exists.
  - With no agents online, show example personas ("👑 Lead", "🤖 Coder") and a small "Example" chip.
- Caption: "Slack shows the app name and each agent's name and emoji. The mark and color style the dashboard."
- Place it with `SidebarPreview` (`step-name.tsx:~337`): two labeled previews, "Dashboard" and "Slack". On phone width, stack them.

#### 3. Tests
**File**: `src/tests/slack-preview.test.ts` (new)
**Changes**: The lead gets `👑`. A worker's emoji equals the Unicode of `getAgentEmoji()` for its name. `appName` cuts at 35 chars and falls back to "Your Swarm". Extension agents are excluded. Use `port: 0` or the existing HTTP test harness, never a fixed port.

### Success Criteria:

#### Automated Verification:
- [ ] Preview tests: `bun run test:root -- src/tests/slack-preview.test.ts`
- [ ] Root typecheck: `bun run tsc:check`
- [ ] UI gates: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] API gates: `bash scripts/check-db-boundary.sh && bun run check:openapi-response-coverage && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
Use the QA environment in `root.md` (restart the API after the change).
- [ ] `curl -s -H "Authorization: Bearer 123123" "http://localhost:3313/api/integrations/slack/preview?name=Acme%20Swarm" | jq` returns `appName: "Acme Swarm"` and a `personas` array.
- [ ] Identity step shows the "Dashboard" and "Slack" previews. Typing a new name updates the Slack preview within about 1 s. Screenshot `/tmp/onb-plan-qa/step7-preview.png`.
- [ ] With no agents online, the preview shows the "Example" chip.
- [ ] Phone width (390 px): the previews stack. Screenshot `/tmp/onb-plan-qa/step7-phone.png`.

#### Manual Verification:
- [ ] Taras compares the mock with a real Slack thread from the dev swarm and accepts the look.

**Implementation Note**: Commit as `[step-7] Slack preview in the Identity step`. `apps/ui/src/api/types.ts` and `client.ts` are shared with steps 5, 6, 8, and 10: re-read before each edit.
