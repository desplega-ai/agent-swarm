---
date: 2026-07-29T15:30:00Z
topic: "Swarm defaults improvement plan — post welcome-test incident"
status: PR 1 IMPLEMENTED (PR #1023, awaiting review/merge); PR 2+ (seeds/defaults) not started
---

# Swarm defaults improvement plan — post welcome-test incident (2026-07-29)

Source incident: cloud welcome session `7da78e8f` on `welcome-test-1785324573245968959` (pi lead, GLM-5.2). 25 failed script runs setting up recurring email briefings; agent bailed to bash+curl and baked `get-config includeSecrets` + curl into the org's 3 recurring schedule taskTemplates. Research: 7 background agents, 2026-07-29.

## Root causes (ranked)

1. **Tool layer reports failures as successes.** `POST /api/scripts/run` always returns HTTP 200; `proxyScriptsApi` trusts `res.ok`, so a failed script yields the literal text "Script run completed." Error/stderr/exitCode live only in `structuredContent.data`, which no harness shows the model.
2. **`(args, ctx)` signature undocumented on the full-surface path.** Stated only in `system.agent.scripts_only_mode` (session-templates.ts:481). The `script_rubric` that full-surface agents get teaches `ctx.api.<slug>` + `Object.keys(ctx.api ?? {})` without the signature — the introspection itself crashes under the param swap.
3. **pi adapter drops `structuredContent` AND `isError`** (`pi-mono-adapter.ts:300-310` joins `content[].text` only; pi-agent-core then sets `isError:false` whenever execute() resolves). Per SEP-1624, Claude Code/Windsurf also ignore structuredContent → `content.text` is the only reliable model channel anywhere. `_ratingNudge` (structuredContent-only) has been invisible on effectively every harness.
4. **`toolError` discards everything but `data.error`** → typecheck failures reach the model as the single word `typecheck_failed` (diagnostics dropped from BOTH channels); label-lint violations, concurrency cap, step-limit messages likewise.
5. **`get-script-run` has `run.error` and doesn't print it** ("status: failed." only).
6. **Examples teach the wrong lesson.** 3 of 24 seeds (gh-pr-snapshot, linear-issue, slack-thread-flatten) use legacy `resolveSecret`+header; none use `ctx.api`. No MCP tool exposes script source (agents must db-query). Session's postmortem agent concluded "ctx.api doesn't exist" — it does (`ctx.ts:25`).
7. **Default agent profiles are undifferentiated.** `defaults.ts` lead vs worker soulMd differ by one noun; no `generateDefaultHeartbeatMd` exists (runner checks for it but never fills it); TOOLS.md is empty scaffolding. Curated `templates/official/*` is good but only applies with explicit `TEMPLATE_ID`.
8. **Lead-on-pi gets phantom tools.** `role==="lead"` checked before `provider==="pi"` (base-prompt.ts:114-130); no `system.session.lead.pi`; pi leads get `context_mode` advertising nonexistent `ctx_*` tools. Untested combination.

## Harness verification matrix (verified against source/issues, 2026-07-29)

| Harness | Model sees | isError | outputSchema | Truncation |
|---|---|---|---|---|
| pi (our adapter) | content[].text joined; structuredContent never read | dropped by our adapter (pi-ai would forward it) | n/a | none ours |
| Claude Code | UNSTABLE across versions: #4427 ignores structured; #15412/#55677 forward ONLY structured, drop content | presumed honored | no client validation; outputSchema presence can silently drop ALL server tools on some versions (#25081) | 25k tokens (MAX_MCP_OUTPUT_TOKENS); per-tool `anthropic/maxResultSizeChars`; over-cap → temp-file offload + ~2KB preview (#45770) |
| Codex (rust, verified in source) | structuredContent ONLY when present (content dropped, #10334), JSON-string-encoded (#31136); content-array JSON when absent | — | parsed but `#[serde(skip)]` — never sent to model; NO validation | ~10KB middle-out (model-configurable ×1.2); 1MiB event cap |
| OpenCode (verified in source) | content ONLY when non-empty (structuredContent dropped, open #38923; #34505 hardened this); JSON.stringify(structured) only when content empty | — | **official-SDK CLIENT-SIDE validation: throws McpError if outputSchema declared but structuredContent missing, or on mismatch** | 50KB/2000 lines → spill file + preview; audio/resource_link silently dropped |
| claude-managed | content only (event schema has no structuredContent field) | tracked (is_error in events) | — | Anthropic-side |

## Design rules (settled, evidence-backed)

- **Both channels must be independently self-sufficient and semantically identical**: content.text = message+details+nudge; structuredContent = { success, message, details?, nudge?, ...data }. Codex sees only structured; pi/opencode/claude-managed see only content; Claude Code flips. Registrar composes both from SwarmToolResult so tools can't diverge.
- **When outputSchema is declared, structuredContent MUST always be returned** (opencode's SDK client throws otherwise) — registrar guarantees this. Output schemas must be permissive: relax `.uuid()` etc. on OUTPUT fields (double validation: our server SDK + opencode client). Input schemas may stay strict (fail before side effects).
- **isError truthful, derived centrally (`!ok`)**; pi adapter must propagate it.
- **Size budget: target ≤~10KB serialized** (Codex is the tightest; middle-out truncation corrupts JSON beyond it). message first; big payloads → future ctx-control middleware (auto-KV + pointer). Claude's `anthropic/maxResultSizeChars` `_meta` annotation available per tool.
- Avoid resource_link/embedded-resource blocks (Codex hard-fails #33404; opencode drops them).
- Nudges: conditional, one sentence, central `NUDGES` map, composed into BOTH channels by the registrar. Dynamic interpolations must stay downstream of `scrubObject`/`scrubSecrets`.

## Docs & runbooks (Taras review 2026-07-29: same-PR rule)

- NEW `runbooks/mcp-tool-results.md`: the SwarmToolResult contract, the both-channels-self-sufficient rule, the harness verification matrix, isError/nudge/size-budget rules, and the REASONING (SEP-1624 + per-harness evidence). Current-behavior-only, no history (same convention as heartbeat runbook).
- CLAUDE.md `important-if` block for "you are adding or modifying MCP tools in src/tools/" → return SwarmToolResult, never raw CallToolResult; permissive output schemas; point at the runbook.
- `runbooks/harness-providers.md`: add per-harness tool-result handling notes (pi adapter isError propagation contract).
- MCP.md regen (`bun run docs:mcp`) — already in scope as B6.

## Workstreams

### A — Tool response truthfulness (highest impact)
- A0 (Taras 2026-07-29, supersedes piecemeal A4/A5/A6 plumbing): **canonical `ToolOutcome` refactor of `createToolRegistrar`** — every tool returns a typed outcome `{ ok, message, data?, render?, nudge? }`; the registrar centrally derives `content.text` (message + optional data rendering + nudge), `structuredContent` (success/message/data), and `isError = !ok`. Single transform point also enables future ctx-control middleware: response-length caps with auto-KV overflow (store full payload under a kv key, append pointer to text), pruning, central scrubSecrets enforcement. Migration: back-compat wrapper first (registrar accepts legacy CallToolResult OR ToolOutcome), then bulk codemod of tool files via delegated fan-out, then strict mode. GOTCHA: per-tool zod `outputSchema`s pin structuredContent shapes (incl. UUID-pinned fields — the -32602 output-validation trap); phase 1 keeps structuredContent shapes as-is and centralizes only text/isError/nudge.
- A1: script-run failure surfacing — inspect `data.error`/`runtimeError` (or fix HTTP status) instead of trusting `res.ok`; fold error+exitCode into text. `src/tools/script-run.ts:47`, `src/http/scripts.ts:496-625`.
- A2: `toolError` data preservation — prefer `data.message ?? data.error`, fold diagnostics/violations counts. `src/tools/script-common.ts:27-90`.
- A3: `get-script-run` — fold `run.error` into text. `src/tools/script-runs.ts:76-86`.
- A4: central `errorResult()` helper always setting `isError:true`; migrate `success:false` tools (db-query, memory-*, kv-*, task-action core). Plus pi adapter: read `result.isError` in `mcpToolsToDefinitions` (pi-agent-core AfterToolCallResult supports it; pi-ai transport already forwards is_error).
- A5: `NUDGES` map + `appendNudge` in `src/tools/utils.ts`; nudge points: failed script-run → error + contract pointer; typecheck fail → first diagnostic +N; empty script-search → seeded-scripts hint; migrate `_ratingNudge` to text.
- A6: content enrichment for thin tools: memory-search (results summary), credential-bindings, mcp-server-list, list-workflow-runs, tracker-status. Precedents: db-query (markdown table), get-tasks (stringify).

### B — Prompting / authoring contract
- B1: new `system.agent.script_authoring_contract` template (signature args-FIRST, ctx shape, argsSchema, fetchJson/ctx.api, `[REDACTED:<KEY>]` egress rule, never bake raw secrets into schedule templates); include at top of `script_rubric` (covers lead+worker+pi in one edit); REMOVE the sig block from `scripts_only_mode` (it renders after a composite already carrying script_rubric — add test: contract exactly once). Register before line 436. Bump 27→28 template-count test.
- B2: tool schema descriptions: script-upsert/script-run `source` fields state the call convention; script-query-types description + `name` optional → proxy to existing `GET /api/scripts/type-defs` (dashboard route, zero backend).
- B3: eval-harness error hints: enrich "must export a default function" (line 106); `ctxSignatureHint` pattern-match in `buildStructuredError` (line 25) for null/undefined `ctx.*` access.
- B4: `ScriptMain` JSDoc in SCRIPT_SDK_TYPES (typecheck.ts:298) + `bun run build:script-types`.
- B5: swarm-scripts skill frontmatter description → mention authoring contract/(args,ctx) (APPROVED by Taras).
- B6: `bun run docs:mcp` regen.

### C — Seeds & examples
- C1: shared header comment (args/ctx cheat-sheet) prepended to all 24 seeds at seed time (seeder is version-aware: pristine copies auto-update, user-modified preserved). Tests: seed-scripts.test.ts.
- C2: `script-get` MCP tool exposing `GET /api/scripts/{id}` (source); update seed_scripts prompt: "read a seed before authoring".
- C3: modernize gh-pr-snapshot/linear-issue/slack-thread-flatten toward `ctx.api.<slug>` — CAVEAT: `ctx.api.<slug>` exists only when the org registered that connection; needs connection-first-with-resolveSecret-fallback shape.

### D — Default agents + composites
- D1: role-branch `generateDefaultSoulMd`/`IdentityMd` (lead: How-You-Lead/Hard-Rules digest; worker: execution/reporting). Update string-match tests (generate-default-claude-md.test.ts, generate-identity-templates.test.ts); add differentiation assertion.
- D2: `generateDefaultHeartbeatMd` for leads (from official/lead/HEARTBEAT.md standing orders); wire into join-swarm.ts + runner.ts:4845-4854 fallback.
- D3: TOOLS.md role-conditional starter content.
- D4: lead default gets explicit schedule/connection ownership line.
- D5: **OPEN QUESTION (cloud control plane, not this repo):** do auto-org leads get `TEMPLATE_ID=official/lead`? If not, cheapest win available.
- D6: `system.session.lead.pi` composite (no context_mode block) + test for lead+pi.
- D7: AST first-param-named-ctx warning in upsert typecheck (`extract-signature.ts` + typecheck.ts ~879 + thread warnings into script-upsert successMessage — currently ignores data). Note: tsc cannot catch the swap (1-param fn assignable to ScriptMain).

## AGREED sequencing (Taras, 2026-07-29 EOD)

**PR 1 (single PR): MCP refactor FIRST + prompt contract — "honest tool results + authoring contract"**

Part 1 — SwarmToolResult refactor (BREAKING, no legacy branch; Taras explicitly ok with breaking migration for a clean state):
- `SwarmToolResult<TData> = { ok, message, details?, data?, nudge? }`; `ToolCallbackWithInfo` returns it (ours, not raw MCP type); registrar transforms centrally: content.text = message [+details] [+nudge] (scrubSecrets), structuredContent = { success, message, ...data } (outputSchema = the forced structured contract), isError = !ok.
- Convert ALL tool files in one sweep (compiler = checklist). Kills toolError + ad-hoc literals.
- proxyScriptsApi: compute ok from data (error/runtimeError/run.status), fold diagnostics/run.error/violations/cap into message. (= "the two errors": 200-on-failure + output-validation trap.)
- Relax UUID-pinned output schema fields → z.string() (kills -32602-after-write trap).
- Conversion rule: message summarizes; details carries model-needed payload (fixes thin tools: memory-search, list tools).
- NUDGES map: failed script-run → authoring-contract pointer; typecheck → first diagnostic +N; empty script-search → seeded scripts; _ratingNudge → text nudge.
- pi adapter: propagate result.isError in mcpToolsToDefinitions.

Part 2 — prompting (same PR; applies to ALL harnesses — script_rubric include reaches every composite; tool/error text is server-side i.e. universal):
- B1 authoring-contract template (+ exactly-once test, 27→28 count bump), B2 tool descriptions + nameless script-query-types via type-defs route, B3 eval-harness hints, B4 ScriptMain JSDoc, B5 skill description tweak (approved), B6 docs:mcp regen, D6 lead.pi composite fix.

**Deferred follow-ups:** ctx-control middleware (auto-KV pruning of long responses at the registrar transform), C1-C3 seeds, D1-D4 defaults, D7 AST warning, D5 cloud TEMPLATE_ID question.

---

## PR 1 IMPLEMENTATION STATUS (2026-07-29 — this section is the handoff record)

**Shipped as PR #1023** (`feat/swarm-tool-result-refactor`, 4 commits: `4d887375` spec, `363a0f2d` sweep+B+docs, `b303f314` pi E2E export, + rbac-allowlist fix). Awaiting Taras review/merge. Everything in "AGREED sequencing → PR 1" above is DONE:

- Part A complete: `SwarmToolResult` + `toolOk`/`toolErr` + `swarmToolOutputSchema` in `src/tools/utils.ts`; registrar finalize pipeline (scrubSecrets → `NUDGES` → transform); ALL ~120 tools in `src/tools/**` + `src/server-user.ts` converted; `proxyScriptsApi` honest (typecheck diagnostics, run errors, `run.status`, violations folded into message/details); output schemas loose/optional/unpinned; pi adapter throws in `execute()` on `isError` (pi-agent-core's only error channel); validation gate `src/tests/swarm-tool-result-gate.test.ts` (finalize contract + audits every registered output schema — this is the enforcement for future tools).
- Part B complete: `system.agent.script_authoring_contract` at top of `script_rubric` (renders exactly once for worker/lead/pi-worker/pi-lead/scripts-only — tested); `system.session.lead.pi` composite (D6) wired in `base-prompt.ts` (pi branch now precedes role branch); B2 tool descriptions + nameless `script-query-types` → `/api/scripts/type-defs`; B3 eval-harness hints + `ctxSignatureHint`; B4 `ScriptMain` JSDoc (+regenerated `.d.ts`); B5 skill description; B6 `docs:mcp`.
- Docs: NEW `runbooks/mcp-tool-results.md` (canonical contract + harness matrix); CLAUDE.md important-if block for `src/tools` authors; `runbooks/harness-providers.md` pi isError section.
- 12 test files translated to the new envelope; ~39 stale-shape failures fixed; full suite 6591 pass / 0 fail; lint/tsc/db-boundary/api-key-boundary/rbac-boundary/rbac-coverage/dep-graph green; manual E2E items 1–7 verified on a fresh server (incl. live pi-adapter isError conformance via `mcpToolsToDefinitions`, now exported).

**Deviations from the plan text (deliberate, review these):**

1. **`allowSecretEgress?: boolean` added to `SwarmToolResult`** — NOT in the original spec. The central scrub middleware redacted *deliberate* credential reveals (`oauth-access-token` returned `[REDACTED:…]`; script-apis create/rotate tokens too). Flag skips scrubbing for that one result; set ONLY on reveal branches: `oauth-access-token`, `script-apis` create/rotate/list-includeSecrets, `get-config`/`list-config` unmasked paths. Documented in the runbook §2 + gate test.
2. **Template count 29, not 28** — the plan's 27→28 counted only the authoring contract; `system.session.lead.pi` (D6, same PR) registers too.
3. **poll-task empty poll returns `ok:true`** — the batch agent made it `toolErr`; reverted in review: an idle poll is a routine outcome, `isError:true` would make every empty poll look like a failed call. (Old wire shape had `success:false` + no isError; new shape is `ok:true` with shouldExit/emptyPollCount in data — the hooks' polling-limit gate reads the server-side counter, not this field.)
4. **Review round restored text-channel payloads** the sweep dropped: task-action/send-task/cancel-task render the task JSON as `details` (old code emitted it as a second content block); get-workflow renders the full definition; skill-search echoes the query again.
5. **`scripts/check-rbac-boundary.sh` allowlist** got a `get-swarm.ts` entry — the sweep added a cosmetic `", lead"` tag in the agent-list details rendering (display, not authz).

**Post-review round (2026-07-29 EOD, after Taras question + Codex bot comments — all addressed):**

6. **Text-channel completeness guarantee added** (Taras: "does content contain 100% of structuredContent?"): it didn't — `data` without `details` was invisible to text-only harnesses. The finalize transform now auto-renders `data` as JSON into `content.text` when `details` is absent (capped ~8KB, curated `details` suppresses it, NOT duplicated into `structuredContent.details`). Runbook §2 + gate tests updated; rbac-charact-skills denial assertions moved from `toBe` to `toStartWith` (denial text still first).
7. **Codex bot P2 (real bug)**: script-search NUDGES entry read `r.data.results` but the proxy nests the body at `r.data.data.results` — the seeded-examples nudge never fired; fixed + gate test now uses the real proxy shape (it had masked the bug).
8. **Codex bot P1**: memory-search rating steer moved from inline `nudge:` into the central `NUDGES` map (policy: steers centrally auditable).
9. **Codex bot P2 (docs)**: `generate-mcp-docs.ts` is a source-text parser — the sweep's `// Plain string, NOT .uuid()` comments corrupted its field splitting and silently dropped rows (send-task `agentId`, task-action rows). Generator now strips whole-line comments before splitting; MCP.md regenerated. NOTE: main's MCP.md had drifted (docs-daily-update enriches rows beyond generator output, e.g. steer-task mode enum); regen is faithful-to-source, the daily job re-enriches.
10. **CI**: `scripts/check-rbac-boundary.sh` (not in the local mirror list!) flagged get-swarm's cosmetic `", lead"` render — allowlisted. All PR #1023 checks green as of `2da020fd`.

11. **Codex bot P1 (round 2)**: the authoring contract's "nothing else" ctx list was wrong for durable workflow scripts — `launch-script-run` builds a different ctx (`ctx.run`, `ctx.step.rawLlm/agentTask/swarmScript`, `ctx.swarm`, `ctx.stdlib`, `ctx.logger`; NO `ctx.api`/`ctx.mcp`/`ctx.swarm.config` — see `src/script-workflows/workflow-ctx.ts`). Template now scopes the list to inline/named scripts and documents the durable ctx separately.
12. **Codex bot P1 (round 2)**: `get-script-run` rendered only a journal COUNT into details — text-only harnesses couldn't see step outcomes. Now renders up to 20 entries (stepKey, stepType, status, error or 400-char result preview) with an overflow marker.

13. **Codex bot P2 (round 3)**: MCP.md rendered imported enum schema constants (`SteerModeSchema`, `OnUnsupportedSchema`, task `status`, `modelTier`, `effort`) as `unknown` — the generator now resolves `z.enum` constants (values + declaration-level defaults, comments stripped) from the tool file or `src/types.ts`. Note: main's MCP.md rows for these were maintained by the docs-daily-update job, not the generator — the generator is now self-sufficient for enums.
14. `origin/main` (`adaa69e8`, telemetry funnel PR) merged into the branch cleanly; all 6 bot review threads replied-to and resolved.

**Known follow-ups discovered during implementation (not blocking):**

- Scheduling guidance ("Pick the Right targetType") lives INSIDE `system.agent.context_mode`, so pi leads (who now correctly drop context_mode) lose it — split scheduling out of context_mode (incident-relevant: the welcome session misused schedules).
- `system.agent.script_rubric` mentions `ctx_*` tool names in its decision table — leaks context-mode vocabulary into pi composites (pre-existing).
- Consider migrating other CallToolResult-era helpers' tests to assert `details` presence (only translated where tests existed).

**Where things live:** contract/`NUDGES` — `src/tools/utils.ts`; honest proxy — `src/tools/script-common.ts`; gate — `src/tests/swarm-tool-result-gate.test.ts`; contract template — `src/prompts/session-templates.ts` (`script_authoring_contract`, before `script_rubric`); canonical doc — `runbooks/mcp-tool-results.md`.

## Verification anchors
- `bun test src/tests/scripts-*.test.ts src/tests/prompt-template-session.test.ts src/tests/base-prompt.test.ts src/tests/seed-scripts.test.ts`
- Manual E2E: local server + inline script-run with `function(ctx)` → expect failure text + hint + isError; script-upsert with type error → expect diagnostics in text; pi worker E2E (LOCAL_TESTING.md recipes) for adapter isError.
