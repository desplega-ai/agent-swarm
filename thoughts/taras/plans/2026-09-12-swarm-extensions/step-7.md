---
id: step-7
name: MCP tools extension-install / extension-list
depends_on: [step-2]
status: done
assignee: codex-terra-step-7-20260914
claimed_at: 2026-09-14T17:45:00+02:00
completed_at: 2026-09-14T20:30:00+02:00
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-7: MCP tools extension-install / extension-list

## Overview
After this step a lead agent can draft a bundle from a task with `extension-install` and inspect the catalog with `extension-list`. An MCP install never enables or activates; it lands disabled (or, for an existing enabled extension, stores a new inactive version) and tells the agent an operator must enable it. Scripts can reach both tools through the SDK.

## Changes Required:

#### 1. Tools
**File**: `src/tools/extension-install.ts`, `src/tools/extension-list.ts`, `src/tools/extension-common.ts` (new)
**Changes**: Copy the shape of `src/tools/script-delete.ts` and `script-common.ts`. `extension-install` input `{ manifest, files, priority?, config? }` (strict input schema, `manifest` validated with `ExtensionManifestSchema`), proxies to `POST /api/extensions/install` the way `proxyScriptsApi` does, forwarding `requestInfo` so RBAC sees the agent principal (`extension.write` is lead-only for agents). Output via `swarmToolOutputSchema({ id, name, version, enabled, status, contentDeduped })`, all optional, no format pins. On a 400 with diagnostics return `toolErr("Extension rejected by typecheck.", { details: <rendered diagnostics> })`. On success `toolOk` with a message that ends with the sentence "An operator must enable it from the dashboard or `POST /api/extensions/{id}/enable`." `extension-list` input `{ enabledOnly?: boolean }`, output `{ extensions: [{ id, name, version, activeVersion, enabled, status, priority, consecutiveFailures }] }` rendered as a table in `details`.

#### 2. Registration
**File**: `src/server.ts` (both registration branches, near lines 331 and 391), `src/scripts-runtime/sdk-allowlist.ts` (`extension_install`, `extension_list` in `SDK_TOOL_NAME_MAP`), `src/scripts-runtime/types/*.d.ts` via `bun run build:script-types`
**Changes**: Register both tools in every branch that registers `script-upsert`. Add the two SDK names. Regenerate and commit the script types. If a capability gate lists tools per surface (`src/tests/scripts-only-gating.test.ts` and the CAPABILITIES surface from memory), add the tools to the same group as `script-upsert`.

#### 3. Tests
**File**: `src/tests/extensions-mcp-tools.test.ts` (new)
**Changes**: Follow `src/tests/scripts-mcp-e2e.test.ts`. Cases: lead agent install lands `enabled: false` and the message names the enable route; worker agent install returns a 403-derived `toolErr`; install of an existing enabled extension stores version N+1 and leaves `activeVersion` at N; typecheck failure returns `toolErr` with diagnostics in `details`; `extension-list` renders the table; both tools pass `swarm-tool-result-gate` expectations.

### Success Criteria:

#### Automated Verification:
- [x] `bun run test:root -- src/tests/extensions-mcp-tools.test.ts src/tests/swarm-tool-result-gate.test.ts src/tests/scripts-only-gating.test.ts`
- [x] `bun scripts/check-sdk-tool-registration.ts`
- [x] `bun run build:script-types && bun run check:script-types`
- [x] `bun run tsc:check && bun run lint`
- [x] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [ ] Boot on a scratch DB, join a lead over MCP (UUID id, `LOCAL_TESTING.md` § Handshake sequence), call `extension-install` with the `minimal` bundle fixture, confirm `structuredContent.enabled === false`, then `GET /api/extensions` shows it `disabled`; call `extension-list` and confirm the table.
- [ ] Join a non-lead worker and confirm `extension-install` returns `isError: true` with a permission message.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.

## Execution notes (2026-09-14)

- Executor: codex-terra, in worktree /tmp/ext-wt/step-7 (branch codex/ext-step-7), merged with --no-ff into docs/swarm-extensions-brainstorm-plan. Report: /tmp/ext-impl/wave3/step-7-report.md.
- Deviation (orchestrator, applies to steps 3-7): the motivating example lives in its own file `src/tests/extensions-example-*.test.ts` instead of a shared `extensions-examples.test.ts`; step-9 consolidates or updates the root.md command to a glob.
- Live QA for this step was run by the orchestrator on the merged tree (Codex sandboxes deny listeners). See root.md "Wave 3 QA" note.
- Wave-3 two-axis review findings and their fix round: /tmp/ext-impl/wave3-fix-prompt.md (the report lands at /tmp/ext-impl/wave3-fix-report.md). Automated boxes are ticked pending that round's green run.
