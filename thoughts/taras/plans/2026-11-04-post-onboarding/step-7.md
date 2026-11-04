---
id: step-7
name: "Connect › AI providers: LLMs tab, unified list, Add provider panel"
track: C
depends_on: [step-5, step-16]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-7: Connect › AI providers: LLMs tab, unified list, Add provider panel

> Design reference (approved 2026-11-04): `mockups/post-onboarding/r5-ai-providers.html` (states 1-3). Decisions: `root.md § Design decisions (step-16)`, "Round 5 decisions". The System One, Embeddings and Transcription tabs are step-17.

## Overview
`/integrations/ai` gets a tab row LLMs | System One | Embeddings | Transcription (this step builds the row and the LLMs tab; the other tabs render a placeholder until step-17). The LLMs tab is one unified list of configured providers with icons: type tag (Subscription, API key, Gateway, OAuth), keys or accounts count, combined status, today and 7-day cost, and an expandable row with the keys (plan, 5h/7d utilization where the API reports it, last used, row menu: Rename, Set plan, Clear rate limit, Remove). "Add provider" is a searchable dropdown of every supported provider, grouped (Subscriptions, API keys, Gateways), that opens a right side panel with the real setup steps, the fields, a validate-on-save state and Save. Only data the API returns today is shown; no "not yet supported" tags. After this step, an admin adds an OpenRouter key from the dropdown without leaving the page and sees it appear in the list with its status.

## Changes Required:

#### 1. Provider registry for the UI
**File**: `apps/ui/src/lib/ai-providers.ts` (new)
**Changes**: One list of the 16 supported LLM providers with id, name, icon, group, config keys, harnesses served and how-to steps, assembled from the sources the round-5 mockup used: `apps/ui/src/lib/integrations-catalog.ts` (llm entries), the OpenAI-compatible gateway list (Vercel AI Gateway, NaN, Helmcode; find it with `rg -l -i helmcode src apps/ui/src`), `CREDENTIAL_POOL_VARS` in `src/utils/credentials.ts` (mirror the var names; the UI must not import `src/`), the setup cards in `apps/ui/src/pages/setup/steps/ai/*.tsx`, and `provider-key-probes.ts` for which providers support a live check on save. Reuse the how-to text from the setup cards instead of writing new copy. A unit test asserts every `CREDENTIAL_POOL_VARS` entry maps to a provider (guard against drift).

#### 2. LLMs tab: unified list
**Files**: `apps/ui/src/pages/connect-pages/ai-page.tsx` (from step-5), `apps/ui/src/components/providers/provider-row.tsx`, `pool-key-row.tsx` (new; extract the row actions from `apps/ui/src/pages/api-keys/page.tsx`)
**Changes**: Rows for providers with at least one key or account. Data: `useApiKeyStatuses` (`GET /api/keys/status`), `useApiKeyCosts` (`GET /api/keys/costs`), `usePoolKeys` (`/api/config/pool-keys`), the Codex accounts (`/api/codex-oauth/accounts`, `apps/ui/src/api/client.ts:1017-1027`) and the Claude utilization windows used by `apps/ui/src/pages/usage/subscriptions-card.tsx`. Status rolls up per provider (worst wins) with the failure reason under the chip on collapsed rows. Footer totals for today and 7 days. Remove calls the pool-key delete (`DELETE /api/config/pool-keys`) or the Codex account delete, with a confirm dialog. The sidebar "AI providers" dot (step-5) and the tab dot read the same worst state.

#### 3. Add provider dropdown and side panel
**Files**: `apps/ui/src/components/providers/add-provider-menu.tsx`, `provider-setup-panel.tsx` (new)
**Changes**: The dropdown lists all providers from the registry, grouped, searchable, with icons; configured ones show a check. Picking one opens a `Sheet` with: header, the how-to steps (e.g. `claude setup-token` with a copy button), the fields (config key names shown small), and Save. Save goes through `POST /api/config/pool-keys` (422 → inline rejection message) or the plain config upsert for single-key providers; providers with a live probe show "Checking…" then the result. **Codex subscription** panel: the in-dashboard sign-in through the existing device flow (`POST /api/codex-oauth/device`, then poll `/api/codex-oauth/device/:flowId/poll`, `apps/ui/src/api/client.ts:996-1015`): show the verification link (opens in a new tab) and the user code, poll until linked, then list the account. The panel states that one ChatGPT subscription serves the codex and pi harnesses (`src/providers/codex-adapter.ts`, `src/providers/pi-mono-adapter.ts`) and opencode only if the code confirms it (grep `src/providers/*opencode*` for the codex OAuth credential before writing that sentence; if absent, list codex and pi only and add a derail note). A server-side PKCE redirect flow is out of scope: the Codex client's redirect URI is fixed to `http://localhost:1455/auth/callback` (`src/providers/codex-oauth/flow.ts:31`).

#### 4. Old Provider keys page and links
**Files**: `apps/ui/src/pages/api-keys/page.tsx`, `apps/ui/src/pages/usage/subscriptions-card.tsx:220`, `apps/ui/src/pages/tasks/[id]/task-details-rail.tsx:753`
**Changes**: The page module shrinks to re-exports of the extracted rows or is deleted once nothing imports it; `/settings/api-keys` already redirects to `/integrations/ai` (step-5). Inbound links target `/integrations/ai`.

#### 5. Tests
**Files**: `apps/ui/src/lib/ai-providers.test.ts`, `apps/ui/src/components/providers/*.test.tsx` (new)
**Changes**: Registry drift guard; status roll-up; add success, 422 and live-probe states; Codex device flow states (code shown, polling, linked, expired); Remove confirm calls the right delete.

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun run lint && bunx tsc -b && bun run test -- ai-providers providers`
- [ ] `bun run check:local && bun run tsc:check:tsc`
- [ ] `bun run e2e:ui -- --grep "@smoke"`
- [ ] `rg -n "settings/api-keys" apps/ui/src --glob '!**/routes.tsx'` returns nothing

#### Automated QA:
- [ ] `AGENT_BROWSER_SESSION=po-step7`: on `/integrations/ai`, open Add provider → OpenRouter, save a fake key: the panel shows the rejection inline (screenshot). Save a real test key from the local env if one is available: the row appears with its status (key masked). Compare with `mockups/post-onboarding/shots/r5-ai-providers-1440-light.png`.
- [ ] Expand a provider row, rename a key, clear its rate limit; `GET /api/keys/status` reflects the new name.
- [ ] Remove a key with the confirm dialog; `GET /api/config/pool-keys` no longer lists it.
- [ ] Open the Codex subscription panel: a device code and verification link appear (do not complete the sign-in in QA). Screenshot.
- [ ] Recording of the add-provider flow for the PR.

#### Manual Verification:
- [ ] Taras completes one Codex device sign-in on the local stack and sees the account listed.

**Implementation Note**: This step is a vertical slice, QA-able on its own. UI routes to Opus. After completing this step, pause for manual confirmation. Commit as `[step-7] Connect › AI providers: LLMs tab` after verification passes. Frontend PR: screenshots and recording in `## Before / after`.
