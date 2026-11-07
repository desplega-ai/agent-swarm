---
id: step-8
name: "Connect › Channels (Slack, Telegram, Discord)"
track: C
depends_on: [step-5, step-16]
status: done
completed_at: 2026-11-04
assignee: po-orch-step-8
claimed_at: 2026-11-04T15:54:22Z
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-8: Connect › Channels (Slack, Telegram, Discord)

> Design reference (approved 2026-11-04): `mockups/post-onboarding/r4-connect.html` (Channels state). Decisions: `root.md § Design decisions (step-16)`, rounds 3 and 4.

## Overview
`/integrations/channels` shows one card each for Slack, Telegram and Discord, plus a compact "More channels" row (Teams, Kapso), under the shared top row (search left, primary action right) and with no page title on desktop. Today Telegram and Discord are adapters inside one 721-line Chat SDK section, and Slack exists twice (socket-mode integration and Chat SDK adapter). Each card shows connected state and opens a per-adapter configuration view. The post-onboarding checklist (step-13) deep-links here. After this step, an admin pastes a Telegram bot token on the Telegram card and the card turns "Connected".

## Changes Required:

#### 1. Channels page
**File**: `apps/ui/src/pages/connect-pages/channels-page.tsx` (from step-5)
**Changes**: Cards for `slack`, `telegram`, `discord`, then "More channels" for `teams` and `kapso`. State: Slack = `deriveIntegrationStatus` for the `slack` catalog entry (socket mode) OR the Chat SDK `slack` adapter connected; Telegram/Discord/Teams = the adapter's `connected` flag from `useChatSdkStatus` (see 3). Each card links to `/integrations/chat-sdk?adapter=<name>` (Telegram, Discord, Teams) or `/integrations/slack`. One Slack card explains the two modes (socket mode for the swarm bot, Chat SDK adapter for the channel SDK) with one primary action. The search row filters the cards.

#### 2. Per-adapter Chat SDK view
**Files**: `apps/ui/src/components/integrations/chat-sdk-section.tsx` (721 lines), `chat-sdk-setup.tsx`, `apps/ui/src/pages/integrations/[id]/page.tsx:346-428`
**Changes**: `ChatSdkSection` accepts `adapter?: ChatSdkAdapterName`; when set it renders only that adapter's fields (`CHAT_SDK_ADAPTER_DEFS`, `apps/ui/src/lib/chat-sdk-fields.ts:51`), its enable toggle, health, and for Telegram the webhook registration (`useRegisterTelegramWebhook`, `chat-sdk-section.tsx:678`). The detail page reads `?adapter=`. Writes still go to the `CHAT_SDK_ADAPTERS` JSON through `useUpsertConfigsBatch`; split the component into `chat-sdk-adapter-form.tsx` per adapter plus the shared shell.

#### 3. `connected` in the chat status response
**File**: `src/http/integrations.ts:137` (`GET /api/integrations/chat/status`), `src/integrations/chat-sdk/status.ts:113-165`
**Changes**: Add a derived `connected: boolean` per adapter (`configured && enabled && health === "ok"`) to the typed response so the UI and step-13's signal share one rule. `bun run docs:openapi`.

#### 4. Tests
**Files**: `apps/ui/src/pages/connect-pages/channels-page.test.tsx` (new), `apps/ui/src/components/integrations/chat-sdk-section.test.tsx`, the chat status test (`rg -l "chat/status|getChatSdkStatus" src/tests`)
**Changes**: Card state per adapter status; `adapter` prop renders one form; `connected` derivation.

### Success Criteria:

#### Automated Verification:
- [x] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- channels-page chat-sdk`
- [x] `bun run test:root -- $(rg -l "chat/status|getChatSdkStatus" src/tests | tr '\n' ' ')`
- [x] `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [x] `bun run e2e:ui -- --grep "@smoke"`

#### Automated QA:
- [ ] `AGENT_BROWSER_SESSION=po-step8`: `/integrations/channels` shows three cards "Not connected" (screenshot next to `mockups/post-onboarding/shots/r4-connect-1440-light.png`). Open Telegram, save a fake token `123456:ABC...`, enable; the card shows "Configured" and the health chip explains the webhook state. Screenshots before and after.
- [x] `/integrations/chat-sdk?adapter=discord` shows only Discord fields. Screenshot.
- [x] `curl <api>/api/integrations/chat/status` shows `connected` per adapter, matching the cards.
- [x] Recording of the Telegram configure flow for the PR.

#### Manual Verification:
- [ ] Taras connects a real Telegram bot once on the local stack and confirms "Connected".

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-8] Connect › Channels` after verification passes. Frontend PR: screenshots and recording in `## Before / after`.

## Implementation notes

- Commit `a301843f8` on `po/step-8`.
- `apps/ui` has no `test` script: the first check ran as `bun test channels-page chat-sdk` (44 pass). In the root runner, the new UI tests pass with `--parallel=4` (CI mode). In one shared process, other files' `mock.module` stubs of the same hooks leak in.
- `check:local` is not ticked: two runs each failed on one different timing test under full-suite load (`scripts-fs.test.ts` native executor, then `otel-event-loop-and-logs.test.ts`). Each passes alone. Neither touches this diff. `tsc:check:tsc`, `lint:slop` and `bun run e2e` (98/98) pass.
- Telegram QA box is not ticked. In webhook mode the API does not check the bot token at start, so a fake token reports `health: "ok"`, `connected: true`, and the card shows "Connected", not "Configured". The adapter logs `setMyCommands failed: Unauthorized` (kept as `lastWarning`, not shown). "Register webhook" shows `Telegram setWebhook failed: Unauthorized`. Follow-up: treat a Telegram 401 at start as `health: "error"` (runtime.ts), or show `lastWarning` for an ok adapter. step-13 should know that `connected` means "running", not "token verified".
- `connected` in the status response: `configured && enabled && health === "ok"`. The UI type keeps it optional and applies the same rule when an older API omits it (`isAdapterConnected` in `lib/channel-cards.ts`).
- Card state and metadata live in `apps/ui/src/lib/channel-cards.ts` (shared by the page and the detail header). The chip is `components/integrations/channel-status-chip.tsx`.
- Slack card: Connected when socket mode is configured (catalog derivation) or the Chat SDK Slack adapter is connected. It lists both modes with a check on the one in use. The primary action goes to the page of the mode in use (socket mode by default).
- "More channels" is a compact row: Teams (adapter, BETA) and WhatsApp (Kapso catalog entry, configured counts as Connected, same as socket-mode Slack).
- Per-adapter view: `?adapter=` on `/integrations/chat-sdk`. The detail page shows the adapter logo, its description and its chip. `ChatSdkSection` renders only that adapter, hides the JSON preview, and filters save messages to that adapter. Decision: switching the adapter on also switches the shared Chat SDK channel on (one action to connect). The "All adapters" link opens the full view.
- `ChatSdkSection` split: `chat-sdk-adapter-form.tsx` holds the adapter panel, fields and Telegram webhook row. `SpecialFlowSectionProps` gained an optional `adapter`.
- Shared files: none of `connect-shell.tsx`, `app-sidebar.tsx`, `routes.tsx` changed. Edited `pages/integrations/[id]/page.tsx`, `components/integrations/special-flows.tsx`, `api/types.ts`.
- Known gaps: the breadcrumb on the adapter view says "Chat SDK", and the right rail stats describe the whole Chat SDK entry.

