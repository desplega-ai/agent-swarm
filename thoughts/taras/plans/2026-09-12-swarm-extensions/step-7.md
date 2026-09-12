---
id: step-7
name: MCP tools extension-upsert / extension-list
depends_on: [step-2]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-7: MCP tools extension-upsert / extension-list

## Overview
After this step a lead agent can draft an extension from a task with `extension-upsert` and inspect the catalog with `extension-list`. An MCP upsert never enables or activates; it lands disabled (or, for an existing enabled extension, stores a new inactive version) and tells the agent an operator must enable it. Scripts can reach both tools through the SDK.

## Changes Required:

#### 1. Tools
**File**: `src/tools/extension-upsert.ts`, `src/tools/extension-list.ts`, `src/tools/extension-common.ts` (new)
**Changes**: Copy the shape of `src/tools/script-delete.ts` and `script-common.ts`. `extension-upsert` input `{ name, source, description?, priority?, config? }` (strict input schema), proxies to `POST /api/extensions/upsert` the way `proxyScriptsApi` does, forwarding `requestInfo` so RBAC sees the agent principal (`extension.write` is lead-only for agents). Output via `swarmToolOutputSchema({ id, name, version, enabled, status, contentDeduped })`, all optional, no format pins. On a 400 with diagnostics return `toolErr("Extension rejected by typecheck.", { details: <rendered diagnostics> })`. On success `toolOk` with a message that ends with the sentence "An operator must enable it from the dashboard or `POST /api/extensions/{id}/enable`." `extension-list` input `{ enabledOnly?: boolean }`, output `{ extensions: [{ id, name, version, activeVersion, enabled, status, priority, consecutiveFailures }] }` rendered as a table in `details`.

#### 2. Registration
**File**: `src/server.ts` (both registration branches, near lines 331 and 391), `src/scripts-runtime/sdk-allowlist.ts` (`extension_upsert`, `extension_list` in `SDK_TOOL_NAME_MAP`), `src/scripts-runtime/types/*.d.ts` via `bun run build:script-types`
**Changes**: Register both tools in every branch that registers `script-upsert`. Add the two SDK names. Regenerate and commit the script types. If a capability gate lists tools per surface (`src/tests/scripts-only-gating.test.ts` and the CAPABILITIES surface from memory), add the tools to the same group as `script-upsert`.

#### 3. Tests
**File**: `src/tests/extensions-mcp-tools.test.ts` (new)
**Changes**: Follow `src/tests/scripts-mcp-e2e.test.ts`. Cases: lead agent upsert lands `enabled: false` and the message names the enable route; worker agent upsert returns a 403-derived `toolErr`; upsert of an existing enabled extension stores version N+1 and leaves `activeVersion` at N; typecheck failure returns `toolErr` with diagnostics in `details`; `extension-list` renders the table; both tools pass `swarm-tool-result-gate` expectations.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run test:root -- src/tests/extensions-mcp-tools.test.ts src/tests/swarm-tool-result-gate.test.ts src/tests/scripts-only-gating.test.ts`
- [ ] `bun scripts/check-sdk-tool-registration.ts`
- [ ] `bun run build:script-types && bun run check:script-types`
- [ ] `bun run tsc:check && bun run lint`
- [ ] `bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`

#### Automated QA:
- [ ] Boot on a scratch DB, join a lead over MCP (UUID id, `LOCAL_TESTING.md` § Handshake sequence), call `extension-upsert` with `src/tests/fixtures/extensions/minimal.ts` source, confirm `structuredContent.enabled === false`, then `GET /api/extensions` shows it `disabled`; call `extension-list` and confirm the table.
- [ ] Join a non-lead worker and confirm `extension-upsert` returns `isError: true` with a permission message.

#### Manual Verification:
- [ ] None.

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. Taras handles commits.
