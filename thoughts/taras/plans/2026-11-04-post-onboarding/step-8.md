---
id: step-8
name: "Connect › Channels (Slack, Telegram, Discord)"
track: C
depends_on: [step-5, step-16]
status: ready
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
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- channels-page chat-sdk`
- [ ] `bun run test:root -- $(rg -l "chat/status|getChatSdkStatus" src/tests | tr '\n' ' ')`
- [ ] `bun run docs:openapi && git diff --exit-code openapi.json`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [ ] `bun run e2e:ui -- --grep "@smoke"`

#### Automated QA:
- [ ] `AGENT_BROWSER_SESSION=po-step8`: `/integrations/channels` shows three cards "Not connected" (screenshot next to `mockups/post-onboarding/shots/r4-connect-1440-light.png`). Open Telegram, save a fake token `123456:ABC...`, enable; the card shows "Configured" and the health chip explains the webhook state. Screenshots before and after.
- [ ] `/integrations/chat-sdk?adapter=discord` shows only Discord fields. Screenshot.
- [ ] `curl <api>/api/integrations/chat/status` shows `connected` per adapter, matching the cards.
- [ ] Recording of the Telegram configure flow for the PR.

#### Manual Verification:
- [ ] Taras connects a real Telegram bot once on the local stack and confirms "Connected".

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-8] Connect › Channels` after verification passes. Frontend PR: screenshots and recording in `## Before / after`.
