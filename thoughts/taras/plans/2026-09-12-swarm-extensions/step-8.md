---
id: step-8
name: Dashboard Settings → Extensions page
depends_on: [step-2]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-8: Dashboard Settings → Extensions page

## Overview
After this step an operator manages extensions from the dashboard: a list with status badges and failure counters, a detail view with a Monaco editor typed against `swarm-extension.d.ts`, enable/disable, priority and config editing, a version list with "activate", and a run-log tail. This step is a leaf and optional for the first merge; REST and MCP already give full control. Frontend PRs require `agent-browser` screenshots uploaded to agent-fs.

## Changes Required:

#### 1. API client and types
**File**: `apps/ui/src/api/client.ts`, `apps/ui/src/api/types.ts`
**Changes**: Add `fetchExtensions`, `fetchExtension`, `fetchExtensionVersions`, `fetchExtensionRuns`, `fetchExtensionTypeDefs`, `upsertExtension`, `patchExtension`, `enableExtension`, `disableExtension`, `activateExtensionVersion`, `deleteExtension` next to the script methods (`upsertScript:1274` as the model). Types mirror `ExtensionSchema`, `ExtensionVersionSchema`, `ExtensionRunSchema` from `src/types.ts` (hand-written in `types.ts` like the script types are).

#### 2. Pages
**File**: `apps/ui/src/pages/settings/extensions-page.tsx`, `apps/ui/src/pages/settings/extension-detail-page.tsx` (new), `apps/ui/src/app/router.tsx`, `apps/ui/src/pages/settings/settings-layout.tsx`
**Changes**: Register `settings/extensions` and `settings/extensions/:id` under the `SettingsLayout` nested route (`router.tsx:152-166`, model on `/settings/configuration` at 163) and add the nav entry in the settings layout next to Configuration. List page: table of name, status badge (`disabled` / `enabled` / `error` / `auto-disabled`), version / activeVersion, priority, consecutiveFailures, updatedAt, with a "New extension" button that opens the detail page with the minimal fixture as a template. Detail page: `ScriptSourceEditor` (`apps/ui/src/components/scripts/script-source-editor.tsx:56`) with `typeDefs` from `fetchExtensionTypeDefs`; Save calls upsert and renders diagnostics inline on 400; Enable / Disable buttons; priority and config (JSON textarea, validated on the server at enable); versions list with "Activate" per row; run-log tail (last 50, auto-refresh every 10 s while the page is open) showing event, action, durationMs, message. Follow the existing settings pages for layout and the theming tokens already in use; no new design system pieces.

#### 3. Lint and build
**File**: `apps/ui/`
**Changes**: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b` must pass. No new dependencies.

### Success Criteria:

#### Automated Verification:
- [ ] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [ ] `bun run tsc:check` (root unchanged)
- [ ] `bun run e2e:ui -- --grep @smoke` still passes (`bun run e2e:ui -- --no-build` after one build)

#### Automated QA:
- [ ] With the API on a scratch DB and the UI on :5274: `agent-browser open http://localhost:5274/settings/extensions`, snapshot, click "New extension", paste the `minimal.ts` fixture into the editor, Save, confirm the list shows it `disabled`; open it, Enable, confirm the badge turns `enabled`; create a task via curl and confirm a run-log row appears within 10 s; Disable; take screenshots at each state to `/tmp/ext-ui-*.png`.
- [ ] Paste `bad-return-shape.ts`, Save, confirm the diagnostic renders inline.
- [ ] Upload the screenshots: `agent-fs write qa/agent-swarm/$(date +%F)-extensions-ui/<name>.png --file /tmp/<name>.png -m "<what it shows>"` and `agent-fs signed-url ... --json`; paste the URLs into the PR body. If agent-fs is unavailable, report the local paths and say the upload was skipped.

#### Manual Verification:
- [ ] Taras reviews the screenshots for visual fit with the other settings pages.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
