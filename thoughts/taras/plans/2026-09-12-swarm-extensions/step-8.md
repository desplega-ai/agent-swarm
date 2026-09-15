---
id: step-8
name: Dashboard Settings → Extensions page
depends_on: [step-2]
status: done
assignee: opus-step-8-20260914
claimed_at: 2026-09-14T17:45:00+02:00
completed_at: 2026-09-14T20:30:00+02:00
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-8: Dashboard Settings → Extensions page

## Overview
After this step an operator manages extensions from the dashboard: a list with status badges and failure counters, a detail view with manifest fields (name, description, version, assets read-only in v1) and a Monaco editor for `hooks.ts` typed against `swarm-extension.d.ts`, enable/disable, priority and config editing, a version list with "activate", and a run-log tail. This step is a leaf and optional for the first merge; REST and MCP already give full control. Frontend PRs require `agent-browser` screenshots uploaded to agent-fs.

## Changes Required:

#### 1. API client and types
**File**: `apps/ui/src/api/client.ts`, `apps/ui/src/api/types.ts`
**Changes**: Add `fetchExtensions`, `fetchExtension`, `fetchExtensionVersions`, `fetchExtensionRuns`, `fetchExtensionTypeDefs`, `installExtension`, `patchExtension`, `enableExtension`, `disableExtension`, `activateExtensionVersion`, `deleteExtension` next to the script methods (`upsertScript:1274` as the model). Types mirror `ExtensionSchema`, `ExtensionVersionSchema`, `ExtensionRunSchema` from `src/types.ts` (hand-written in `types.ts` like the script types are).

#### 2. Pages
**File**: `apps/ui/src/pages/settings/extensions-page.tsx`, `apps/ui/src/pages/settings/extension-detail-page.tsx` (new), `apps/ui/src/app/router.tsx`, `apps/ui/src/pages/settings/settings-layout.tsx`
**Changes**: Register `settings/extensions` and `settings/extensions/:id` under the `SettingsLayout` nested route (`router.tsx:152-166`, model on `/settings/configuration` at 163) and add the nav entry in the settings layout next to Configuration. List page: table of name, status badge (`disabled` / `enabled` / `error` / `auto-disabled`), version / activeVersion, priority, consecutiveFailures, updatedAt, with a "New extension" button that opens the detail page with the `minimal` bundle as a template (manifest form + hooks editor). Detail page: `ScriptSourceEditor` (`apps/ui/src/components/scripts/script-source-editor.tsx:56`) with `typeDefs` from `fetchExtensionTypeDefs`; Save builds `{ manifest, files: { [manifest.assets.hooks]: editorValue } }`, calls install, and renders diagnostics inline on 400; Enable / Disable buttons; priority and config (JSON textarea, validated on the server at enable); versions list with "Activate" per row; run-log tail (last 50, auto-refresh every 10 s while the page is open) showing event, action, durationMs, message. Follow the existing settings pages for layout and the theming tokens already in use; no new design system pieces.

#### 3. Lint and build
**File**: `apps/ui/`
**Changes**: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b` must pass. No new dependencies.

### Success Criteria:

#### Automated Verification:
- [x] `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`
- [x] `bun run tsc:check` (root unchanged)
- [x] `bun run e2e:ui -- --grep @smoke` still passes (`bun run e2e:ui -- --no-build` after one build)

#### Automated QA:
- [ ] With the API on a scratch DB and the UI on :5274: `agent-browser open http://localhost:5274/settings/extensions`, snapshot, click "New extension", fill the manifest form, paste the `minimal` hooks file into the editor, Save, confirm the list shows it `disabled`; open it, Enable, confirm the badge turns `enabled`; create a task via curl and confirm a run-log row appears within 10 s; Disable; take screenshots at each state to `/tmp/ext-ui-*.png`.
- [ ] Paste the `bad-return-shape` hooks file, Save, confirm the diagnostic renders inline.
- [ ] Upload the screenshots: `agent-fs write qa/agent-swarm/$(date +%F)-extensions-ui/<name>.png --file /tmp/<name>.png -m "<what it shows>"` and `agent-fs signed-url ... --json`; paste the URLs into the PR body. If agent-fs is unavailable, report the local paths and say the upload was skipped.

#### Manual Verification:
- [ ] Taras reviews the screenshots for visual fit with the other settings pages.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.

## Execution notes (2026-09-14)

- Executor: opus, in worktree /tmp/ext-wt/step-8 (branch codex/ext-step-8), merged with --no-ff into docs/swarm-extensions-brainstorm-plan. Report: /tmp/ext-impl/wave3/step-8-report.md.
- Deviation (orchestrator, applies to steps 3-7): the motivating example lives in its own file `src/tests/extensions-example-*.test.ts` instead of a shared `extensions-examples.test.ts`; step-9 consolidates or updates the root.md command to a glob.
- Live QA for this step was run by the orchestrator on the merged tree (Codex sandboxes deny listeners). See root.md "Wave 3 QA" note.
- Wave-3 two-axis review findings and their fix round: /tmp/ext-impl/wave3-fix-prompt.md (the report lands at /tmp/ext-impl/wave3-fix-report.md). Automated boxes are ticked pending that round's green run.
