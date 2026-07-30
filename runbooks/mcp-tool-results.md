# MCP tool results

> **Maintained doc — current logic only (no history).** This runbook is the canonical reference for the `SwarmToolResult` contract every MCP tool returns and the per-harness evidence behind it. Keep it in sync with the code: when you change any of this, update this file in the same PR (enforced by the CLAUDE.md rule). It documents *current* behavior — do not turn it into a changelog.

Owner code: `src/tools/utils.ts` (contract + registrar finalize pipeline), `src/http/mcp-bridge.ts` (server-authored script-call origin), `src/scripts-runtime/response-limit.ts` (script SDK hard response guard), `src/tools/script-common.ts` (`proxyScriptsApi` — the reference honest-failure-detection implementation), `src/providers/pi-mono-adapter.ts` (`mcpToolsToDefinitions` — the pi-side `isError` propagation), `src/tests/swarm-tool-result-gate.test.ts` (the validation gate).

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
  truncation?: {       // registrar-owned overflow pointer; tools do not set this
    truncated: true;
    fullValueAt: string;
    originalBytes: number;
    limitBytes: number;
    retrieval: string;
  };
};
```

Build one with `toolOk(message, extras?)` / `toolErr(message, extras?)` (`src/tools/utils.ts`). Tools never construct `{ content: [...], structuredContent: ..., isError: ... }` by hand — `createToolRegistrar`'s wrapper calls `finalizeSwarmToolResult(toolName, outcome)` on whatever the callback returns, so the wire-level `CallToolResult` is composed in exactly one place for every tool.

**Conversion rule** when adding or migrating a tool: `message` summarizes ("Script run failed: TypeError: ctx.api is undefined"); `details` carries the payload the model actually needs to act (diagnostics, stderr, a rendered table) — this is what fixes thin tools like `memory-search` or list-style tools that previously only echoed a count.

## 2. The registrar finalize pipeline

`finalizeSwarmToolResult` runs an ordered middleware pipeline over the `SwarmToolResult` before building the wire result:

1. **scrub** (`scrubMiddleware` → `scrubObject`) — runs first so every later stage only ever sees already-scrubbed data. Escape hatch: a result may set `allowSecretEgress: true` to skip scrubbing — ONLY for deliberate credential-reveal branches whose entire purpose is handing the agent a secret (`oauth-access-token`, `script-apis` create/rotate/list-includeSecrets, `get-config`/`list-config` with unmasked secrets). These tools register the revealed value via `registerVolatileSecret` so every *other* egress (logs, other tool results) still redacts it; without the flag the central scrubber would redact the reveal itself.
2. **nudge** (`nudgeMiddleware`) — if the tool didn't set an explicit `nudge`, look up `NUDGES[toolName]?.(result)` and attach it if present. An explicit tool-provided nudge always wins over the central map.
3. **ctx-control** (`ctxControlMiddleware`) — first checks the server-authored call origin. Calls made by `ctx.swarm.*` through `/api/mcp-bridge` are script-internal and skip the model-context ceiling. Agent-facing calls compose the full would-be wire result, measure `Buffer.byteLength(JSON.stringify(result), "utf8")` across `content`, `structuredContent`, and `isError` together, and pass results at or below 10,000 bytes through unchanged. Oversized agent-facing results are persisted to the server-owned KV store and replaced before the final transform. `kv-get` is exempt (`CTX_CONTROL_EXEMPT_TOOLS`): it is the retrieval path for spilled values, so its oversized results go out whole and the harness applies its own native truncation.
4. **final transform** (`composeWireResult`) — trims explicit `details`, auto-renders data only when details is absent, and composes the independently usable text and structured channels.

After the pipeline, the transform composes both channels from the same three fields:

```ts
text = [message, nudge, details ?? autoRenderedData].filter(Boolean).join("\n\n")
structuredContent = { ...data, success: ok, message, details?, nudge? }
isError = !ok
```

The payload rendering goes LAST in the text join: harnesses that truncate long text cut from the tail (or keep head+tail), so `message` and `nudge` lead and a cut lands inside the payload — a truncated JSON rendering still shows its first key values.

**Text-channel completeness guarantee**: when a tool sets `data` but no non-blank `details`, the transform auto-renders the data as pretty-printed JSON into the text channel. A payload can therefore never be visible only to structured-content readers; an explicit `details` (curated rendering) always suppresses the fallback, and the fallback is *not* copied into `structuredContent.details` (the structured channel already carries `data` verbatim). If the resulting combined wire payload is too large, ctx-control replaces it on both channels as described below.

### Ctx-control overflow contract

Ctx-control stores the full canonical, scrubbed outcome directly through the API server's DB helper—never by calling the MCP `kv-set` tool:

- **Namespace:** `mcp:overflow:<agentId>`. Both MCP and REST KV surfaces enforce
  ownership for this namespace family; another authenticated agent cannot get,
  list, overwrite, increment, or delete an agent's spill rows.
- **Key:** `v1/<sanitized-tool-name>/<sha256(canonical-payload)>`. Identical scrubbed outcomes reuse the same deterministic key and refresh its TTL.
- **TTL:** 24 hours. Before every spill, the middleware proactively deletes
  expired rows across the entire `mcp:overflow:*` namespace family, including
  rows owned by inactive agents; point reads retain the KV store's normal
  lazy-expiry behavior.
- **Value:** raw string JSON containing `{ version, toolName, outcome }`, including full `details`/`data`/`nudge`. The KV table itself has no declared `TEXT` size constraint; the public KV PUT surfaces impose a separate 2 MiB request cap, which does not apply to this direct server-side write.

The wire replacement keeps `message`, `nudge`, and `truncation` on both channel families. For array-shaped structured data, ctx-control preserves the array key and finds the largest leading element prefix that fits after accounting for the pointer, prose preview, and both wire channels. It also rewrites or augments the human message with the surviving count, so callers cannot confuse a shortened array with a genuine full or empty result. Tool-authored prose keeps a readable prefix and marker. Scalar-only oversized JSON is still omitted as a complete unit—returning a scalar or malformed JSON prefix would be misleading. Details-only outcomes are persisted the same way as data outcomes, so `fullValueAt` can never become `"not retained"`.

An oversized request without an authenticated agent identity is never written
to a shared fallback namespace. It receives an explicit unavailable pointer and
guidance to retry with `X-Agent-ID`; normal authenticated MCP calls always use
their private `mcp:overflow:<agentId>` partition.

`truncation` is machine-readable:

```ts
{
  truncated: true,
  fullValueAt: "kv://mcp:overflow:<agentId>/v1/<tool>/<sha256>",
  originalBytes: 12345,
  limitBytes: 10000,
  retrieval: 'kv-get({"namespace":"mcp:overflow:<agentId>","key":"v1/<tool>/<sha256>"}) returns the full value (your harness may truncate it); to filter or aggregate it instead, process it in a script via ctx.swarm.kv_get.'
}
```

The retrieval guidance and compact JSON truncation metadata appear in both `content.text` and `structuredContent`. Retrieval is deliberately unbounded at the model-facing `kv-get` tool: it returns the whole stored value and the harness applies its own native truncation (there is no server-side chunking API — reassembling a big value in 10KB tool results would cost the model several times the payload in context). The `kv-get` entry in `NUDGES` steers big-value work toward scripts, where `ctx.swarm.kv_get` fetches the full value into the sandbox and only the derived answer enters the model's context.

### Script-internal SDK boundary

The 10,000-byte ceiling protects model context, not the script sandbox heap. The bridge therefore marks its synthetic MCP request object in a server-private `WeakSet`; this origin cannot be selected through request headers or the bridge body. The registrar still scrubs secrets and applies nudges, but skips ctx-control for that internal call. REST-mapped SDK methods already bypass the registrar and remain full as well.

Both script clients—inline/named scripts in `src/scripts-runtime/swarm-sdk.ts` and durable workflow scripts in `src/script-workflows/workflow-ctx.ts`—stream every response through `readScriptSdkJsonResponse`. It accepts up to 64 MiB and then cancels the body and throws a loud error; it never silently truncates or deletes a field. Sixty-four MiB is deliberately far above the model-context ceiling while leaving headroom inside the standard runtime's 512 MiB process limit for the UTF-16 string, parsed JSON graph, user code, and runtime overhead.

The three boundaries are therefore intentionally asymmetric:

1. Agent → MCP tool → model context: 10,000-byte ctx-control applies.
2. `ctx.swarm.*` → script sandbox heap: full response up to the separate 64 MiB hard-error guard.
3. Script return → `script-run` MCP tool → model context: 10,000-byte ctx-control applies again.

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

Target **≤10,000 UTF-8 bytes serialized** per agent-facing tool result. Codex is the tightest real constraint: its ~10KB middle-out truncation (model-configurable ×1.2) operates on the JSON-string-encoded `structuredContent`, and truncating mid-JSON corrupts the payload rather than gracefully clipping text. Ctx-control measures the composed result rather than `details` alone, so duplicated text plus structured data is included in the decision. Script-internal SDK responses use the separate 64 MiB hard-error guard described above.

`message` and `nudge` go first in the text join; the payload rendering is last so a harness-side tail cut lands inside it. Oversized results are replaced with a bounded preview/omission plus the same KV pointer and retrieval guidance on **both** channels. Channel separation cannot save context here: pi/OpenCode/claude-managed drop structured content, while Codex drops text content; Claude Code varies by version. Do not hand-roll `details` truncation per tool—paginate/slim at the source when that is the natural contract, otherwise rely on the registrar.

Claude Code exposes a per-tool `anthropic/maxResultSizeChars` `_meta` annotation as an available (not yet used) lever for tools that are known to be chunky.

## 8. Avoid `resource_link` / embedded-resource content blocks

Don't return MCP `resource_link` or embedded-resource content blocks. Codex hard-fails on them and opencode silently drops them — on both harnesses this is worse than just inlining the same information as text. Stick to `{ type: "text" }` content blocks (which is all `finalizeSwarmToolResult` ever produces) plus `structuredContent`.

## 9. The validation gate

`src/tests/swarm-tool-result-gate.test.ts` is the enforcement mechanism for this whole contract. Two parts:

1. **Finalize-pipeline contract tests** — freeze `finalizeSwarmToolResult`'s behavior: ok/error shape, details+nudge composing identically into both channels, `structuredContent` always present, `data` unable to clobber the envelope, the empty-message fallback, secret scrubbing before spill, UTF-8 wire ceilings, prose-vs-JSON overflow rendering, details-only retention, non-ASCII KV round-trip fidelity, and `NUDGES` map behavior (including "explicit nudge wins").
2. **Registered-tool output-schema audit** — boots a real server (`createServer({ fullSurface: true })`), walks every registered tool's `outputSchema` via the zod internal `_zod.def` shape, and fails the suite if any declared output schema:
   - pins a `string` format on an output field,
   - is a strict/non-loose object (missing `catchall`, i.e. not built via `z.looseObject` / `swarmToolOutputSchema`),
   - rejects the bare result envelope (`{ success, message, details, nudge, extraDataKey }`) — i.e. has a required data field.

Run it with `bun run test:root -- src/tests/swarm-tool-result-gate.test.ts`. Any new tool with an `outputSchema` is covered automatically — no per-tool test to add.

## Trigger paths

This runbook applies when modifying:

- `src/tools/utils.ts` (the contract, registrar, finalize pipeline, `NUDGES` map)
- `src/http/mcp-bridge.ts` (script-internal origin stamping)
- `src/scripts-runtime/response-limit.ts`, `src/scripts-runtime/swarm-sdk.ts`, or `src/script-workflows/workflow-ctx.ts` (script-internal response guard)
- `src/tools/script-common.ts` (`proxyScriptsApi` honest-failure detection, `capDetails`)
- Any file under `src/tools/` that registers an MCP tool
- `src/providers/pi-mono-adapter.ts`'s `mcpToolsToDefinitions` (isError propagation)
- `src/tests/swarm-tool-result-gate.test.ts`
