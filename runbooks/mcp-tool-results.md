# MCP tool results

> **Maintained doc — current logic only (no history).** This runbook is the canonical reference for the `SwarmToolResult` contract every MCP tool returns and the per-harness evidence behind it. Keep it in sync with the code: when you change any of this, update this file in the same PR (enforced by the CLAUDE.md rule). It documents *current* behavior — do not turn it into a changelog.

Owner code: `src/tools/utils.ts` (contract + registrar finalize pipeline), `src/tools/script-common.ts` (`proxyScriptsApi` — the reference honest-failure-detection implementation), `src/providers/pi-mono-adapter.ts` (`mcpToolsToDefinitions` — the pi-side `isError` propagation), `src/tests/swarm-tool-result-gate.test.ts` (the validation gate).

---

## 1. The contract

Every MCP tool handler returns a `SwarmToolResult`, never a raw `CallToolResult`:

```ts
type SwarmToolResult<TData> = {
  ok: boolean;        // truthful outcome — becomes isError = !ok and structuredContent.success
  message: string;    // required, non-empty one-line summary — the first thing every harness shows the model
  details?: string;   // model-needed payload rendering (tables, diagnostics, stderr) — appended to text
  data?: TData;        // structured payload, spread into structuredContent alongside the envelope keys
  nudge?: string;      // single-sentence conditional steer, appended to BOTH channels
};
```

Build one with `toolOk(message, extras?)` / `toolErr(message, extras?)` (`src/tools/utils.ts`). Tools never construct `{ content: [...], structuredContent: ..., isError: ... }` by hand — `createToolRegistrar`'s wrapper calls `finalizeSwarmToolResult(toolName, outcome)` on whatever the callback returns, so the wire-level `CallToolResult` is composed in exactly one place for every tool.

**Conversion rule** when adding or migrating a tool: `message` summarizes ("Script run failed: TypeError: ctx.api is undefined"); `details` carries the payload the model actually needs to act (diagnostics, stderr, a rendered table) — this is what fixes thin tools like `memory-search` or list-style tools that previously only echoed a count.

## 2. The registrar finalize pipeline

`finalizeSwarmToolResult` runs an ordered middleware pipeline over the `SwarmToolResult` before building the wire result:

1. **scrub** (`scrubMiddleware` → `scrubObject`) — runs first so every later stage only ever sees already-scrubbed data. Escape hatch: a result may set `allowSecretEgress: true` to skip scrubbing — ONLY for deliberate credential-reveal branches whose entire purpose is handing the agent a secret (`oauth-access-token`, `script-apis` create/rotate/list-includeSecrets, `get-config`/`list-config` with unmasked secrets). These tools register the revealed value via `registerVolatileSecret` so every *other* egress (logs, other tool results) still redacts it; without the flag the central scrubber would redact the reveal itself.
2. **nudge** (`nudgeMiddleware`) — if the tool didn't set an explicit `nudge`, look up `NUDGES[toolName]?.(result)` and attach it if present. An explicit tool-provided nudge always wins over the central map.
3. **details normalization** — after middleware scrubbing, explicit `details` is trimmed and capped at ~8KB. The same normalized value is written to text and `structuredContent.details`; whitespace-only details counts as absent so the data fallback remains visible.
4. *(reserved)* future ctx-control middleware (response pruning, auto-KV overflow) slots in between nudge and the final transform — not implemented yet.

After the pipeline, the transform composes both channels from the same three fields:

```ts
text = [message, details ?? autoRenderedData, nudge].filter(Boolean).join("\n\n")
structuredContent = { ...data, success: ok, message, details?, nudge? }
isError = !ok
```

**Text-channel completeness guarantee**: when a tool sets `data` but no non-blank `details`, the transform auto-renders the data as pretty-printed JSON into the text channel (capped at ~8KB — Codex's middle-out truncation is the tightest harness budget). A payload can therefore never be visible only to structured-content readers; an explicit `details` (curated rendering) always suppresses the fallback, and the fallback is *not* copied into `structuredContent.details` (the structured channel already carries `data` verbatim).

An empty/blank `message` never reaches a harness silently: the registrar logs a warning and substitutes a loud fallback ("Tool call succeeded (no message provided)." / "Tool call failed (no message provided).") so the text channel is never blank.

`data` is spread into `structuredContent` **before** the envelope keys, so a tool cannot accidentally clobber `success`/`message`/`details`/`nudge` by naming a data field the same thing — the envelope always wins.

## 3. Both channels must be independently self-sufficient

Different harnesses read different channels, and no channel is reliably read by all of them. The registrar therefore composes `content.text` and `structuredContent` from the *same* `message`/`details`/`nudge`/`data` so they are semantically identical and neither can diverge — a tool author cannot accidentally put the real error only in `data` while leaving `text` generic.

### Verified harness matrix (2026-07-29)

| Harness | Model sees | isError | outputSchema | Truncation |
|---|---|---|---|---|
| pi (our adapter) | `content[].text` joined; `structuredContent` never read | dropped by our adapter unless propagated (pi-ai would forward it) | n/a | none ours |
| Claude Code | UNSTABLE across versions: some ignore structured content, some forward ONLY structured content and drop `content` | presumed honored | no client validation; `outputSchema` presence can silently drop ALL server tools on some versions | 25k tokens (`MAX_MCP_OUTPUT_TOKENS`); per-tool `anthropic/maxResultSizeChars`; over-cap → temp-file offload + ~2KB preview |
| Codex (rust) | `structuredContent` ONLY when present (`content` dropped), JSON-string-encoded; `content`-array JSON when `structuredContent` absent | — | parsed but never sent to the model; NO validation | ~10KB middle-out (model-configurable ×1.2); 1MiB event cap |
| OpenCode | `content` ONLY when non-empty (`structuredContent` dropped when content is present); `JSON.stringify(structuredContent)` only when `content` is empty | — | **official-SDK CLIENT-SIDE validation: throws `McpError` if `outputSchema` is declared but `structuredContent` is missing, or on mismatch** | 50KB/2000 lines → spill file + preview; audio/resource_link blocks silently dropped |
| claude-managed | `content` only (event schema has no `structuredContent` field) | tracked (`is_error` in events) | — | Anthropic-side |

**Practical reading:** pi, opencode, and claude-managed effectively only ever see `content.text`. Codex effectively only ever sees `structuredContent`. Claude Code is unstable in both directions depending on version. There is no channel that is safe to skip — every field the model needs to act on must appear in `content.text`, and every tool that declares an `outputSchema` must also populate `structuredContent` on every response (see §4).

## 4. `isError` and `structuredContent`-always-present

`isError = !ok`, derived centrally by the registrar — tools never set it themselves.

**pi adapter must propagate `isError`.** `mcpToolsToDefinitions` in `src/providers/pi-mono-adapter.ts` calls `mcpClient.callTool(...)` and gets back the raw `CallToolResult`. pi-agent-core derives a tool call's error flag from whether the tool's `execute()` **throws**, not from any field on the resolved value — so the adapter must explicitly `throw new Error(text)` when `result.isError` is true; a resolved return would silently report a failed tool call as a success to the model. This is a pi-side wrapper responsibility, not something the registrar can enforce from the server side.

**`structuredContent` is always present when an `outputSchema` is declared.** OpenCode's official SDK client throws `McpError` client-side if a tool declares an `outputSchema` but the response has no `structuredContent`, or if `structuredContent` doesn't validate against it. The registrar guarantees `structuredContent` is populated on every response (success and error alike) so this never trips.

## 5. Output schemas: loose, unpinned, all-optional

Output schemas are validated **twice** — once by our own server-side SDK, once by opencode's client — so a schema that's too strict rejects an honest response **after the tool's side effect already landed** (the "-32602-after-write trap": e.g. a UUID-format-pinned output field rejects a legitimate response on `get-tasks`/`get-task-details`/`store-progress`/`memory-search`, and the underlying write already happened, so a retry double-writes).

Rules for any tool that declares an `outputSchema`:

- Build it with `swarmToolOutputSchema(dataShape?)` (`src/tools/utils.ts`), which wraps `swarmToolEnvelopeShape` (`success`, `message`, `details?`, `nudge?`) + your data shape in `z.looseObject(...)`. Plain `z.object(...)` emits `additionalProperties: false` in the generated JSON Schema, which is exactly what makes opencode's client reject the spread `data` keys.
- Every tool-specific data field must be **optional** — an error result carries no tool data, so a schema that requires a data field rejects every honest error response.
- Never pin a `string` **output** field to a format (`.uuid()`, `.email()`, `.datetime()`, etc.). Relax to `z.string()`. **Input schemas may stay strict** — they fail before any side effect runs, so there's no after-the-write trap there.

## 6. `NUDGES` map

Central, keyed by tool name, in `src/tools/utils.ts`:

```ts
export const NUDGES: Record<string, (result: SwarmToolResult) => string | undefined> = {
  "script-run": (r) => (r.ok ? undefined : SCRIPT_AUTHORING_NUDGE),
  "script-upsert": (r) => (r.ok ? undefined : SCRIPT_AUTHORING_NUDGE),
  "launch-script-run": (r) => (r.ok ? undefined : SCRIPT_AUTHORING_NUDGE),
  "get-script-run": (r) => (r.ok ? undefined : SCRIPT_AUTHORING_NUDGE),
  "script-search": (r) => { /* empty-results hint pointing at seeded scripts */ },
};
```

The `nudgeMiddleware` stage applies `NUDGES[toolName]?.(result)` only when the tool didn't already set an explicit `nudge` — an explicit nudge always wins. Keep entries to a single conditional sentence, and derive them only from fields on the (already-scrubbed) result — never from closure state, since the middleware runs after `scrubMiddleware` specifically so nudges can't leak unscrubbed data.

## 7. Size budget

Target **≤~10KB serialized** per tool result. Codex is the tightest real constraint: its ~10KB middle-out truncation (model-configurable ×1.2) operates on the JSON-string-encoded `structuredContent`, and truncating mid-JSON corrupts the payload rather than gracefully clipping text. The registrar centrally trims and caps every explicit `details` string at ~8KB with a `[truncated N chars]` marker in both channels. Structured `data` is not truncated, so high-cardinality tools must still paginate or slim that payload at the source.

`message` goes first in the text join, so it survives even if a harness truncates from the tail. Large payloads beyond the budget are a future ctx-control middleware problem (auto-KV storage + a pointer appended to text) — not implemented yet. Do not hand-roll `details` truncation per tool; paginate or slim large structured datasets at the source.

Claude Code exposes a per-tool `anthropic/maxResultSizeChars` `_meta` annotation as an available (not yet used) lever for tools that are known to be chunky.

## 8. Avoid `resource_link` / embedded-resource content blocks

Don't return MCP `resource_link` or embedded-resource content blocks. Codex hard-fails on them and opencode silently drops them — on both harnesses this is worse than just inlining the same information as text. Stick to `{ type: "text" }` content blocks (which is all `finalizeSwarmToolResult` ever produces) plus `structuredContent`.

## 9. The validation gate

`src/tests/swarm-tool-result-gate.test.ts` is the enforcement mechanism for this whole contract. Two parts:

1. **Finalize-pipeline contract tests** — freeze `finalizeSwarmToolResult`'s behavior: ok/error shape, details+nudge composing identically into both channels, `structuredContent` always present, `data` unable to clobber the envelope, the empty-message fallback, secret scrubbing at the egress point, and `NUDGES` map behavior (including "explicit nudge wins").
2. **Registered-tool output-schema audit** — boots a real server (`createServer({ fullSurface: true })`), walks every registered tool's `outputSchema` via the zod internal `_zod.def` shape, and fails the suite if any declared output schema:
   - pins a `string` format on an output field,
   - is a strict/non-loose object (missing `catchall`, i.e. not built via `z.looseObject` / `swarmToolOutputSchema`),
   - rejects the bare result envelope (`{ success, message, details, nudge, extraDataKey }`) — i.e. has a required data field.

Run it with `bun test src/tests/swarm-tool-result-gate.test.ts`. Any new tool with an `outputSchema` is covered automatically — no per-tool test to add.

## Trigger paths

This runbook applies when modifying:

- `src/tools/utils.ts` (the contract, registrar, finalize pipeline, `NUDGES` map)
- `src/tools/script-common.ts` (`proxyScriptsApi` honest-failure detection, `capDetails`)
- Any file under `src/tools/` that registers an MCP tool
- `src/providers/pi-mono-adapter.ts`'s `mcpToolsToDefinitions` (isError propagation)
- `src/tests/swarm-tool-result-gate.test.ts`
