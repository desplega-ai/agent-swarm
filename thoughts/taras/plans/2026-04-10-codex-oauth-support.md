---
date: 2026-04-10
planner: taras
topic: codex-oauth-support
status: completed
---

# Codex ChatGPT Subscription OAuth Implementation Plan

## Overview

Add native ChatGPT OAuth support for the Codex provider so deployed agents can authenticate against ChatGPT Plus/Pro subscriptions via `~/.codex/auth.json` restoration from the swarm API config store. This is Phase 8 from the original Codex support plan (`thoughts/taras/plans/2026-04-09-codex-app-server-support.md`), deferred from the initial Codex PR.

Currently, deployed Codex workers require `OPENAI_API_KEY` (standard OpenAI API billing) or a manually pre-seeded `~/.codex/auth.json`. This plan adds a third auth path: the `agent-swarm codex-login` CLI command runs the ChatGPT OAuth PKCE flow (same as `codex login`), persists credentials to the swarm API config store, and the `docker-entrypoint.sh` restores them into `~/.codex/auth.json` at boot — giving ChatGPT Plus/Pro subscribers billing parity with the local Codex CLI.

## Current State Analysis

### What exists

- **Codex adapter** (`src/providers/codex-adapter.ts`) — fully functional via `HARNESS_PROVIDER=codex`, creates `Codex` SDK instances with explicit `env.OPENAI_API_KEY`
- **Entrypoint auth** (`docker-entrypoint.sh:13-38`) — validates `OPENAI_API_KEY` or `~/.codex/auth.json`; bootstraps `auth.json` from `OPENAI_API_KEY` via `codex login --with-api-key`
- **Config store fetch** (`docker-entrypoint.sh:200-223`) — already fetches resolved config from `GET /api/config/resolved?includeSecrets=true` and exports as env vars
- **Config MCP tools** (`src/tools/swarm-config/set-config.ts`, `get-config.ts`) — read/write config entries (including secrets) via the API
- **OAuth DB tables** (`src/be/db-queries/oauth.ts`) — `oauth_apps` and `oauth_tokens` tables exist for the Slack/GitHub OAuth flows, but these are a different abstraction (per-provider app + token, not per-agent config secrets)
- **Credential tracking** (`src/utils/credentials.ts`) — `PROVIDER_CREDENTIAL_VARS.codex = ["OPENAI_API_KEY"]` (no OAuth key type yet)
- **Pi-mono reference** (`node_modules/@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js`) — complete, battle-tested OAuth flow with PKCE, loopback server on port 1455, token exchange, refresh, JWT decoding, and `chatgpt_account_id` extraction. Same `CLIENT_ID`, `AUTHORIZE_URL`, `TOKEN_URL`, `REDIRECT_URI`, `SCOPE` constants we need.
- **Pi-mono reference** (`node_modules/@mariozechner/pi-ai/dist/utils/oauth/pkce.js`) — cross-runtime PKCE using Web Crypto API
- **Pi-mono auth storage** (`node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js`) — `AuthStorage` class with file locking, auto-refresh, and `login()` / `getApiKey()` methods. Uses `auth.json` as the file backend.
- **Codex CLI auth format** (`~/.codex/auth.json`) — observed on Taras's machine:
  ```json
  {
    "auth_mode": "chatgpt",
    "OPENAI_API_KEY": null,
    "tokens": {
      "id_token": "eyJ...",
      "access_token": "eyJ...",
      "refresh_token": "rt_...",
      "account_id": "c724a178-..."
    },
    "last_refresh": "2026-04-09T09:21:49.072102Z"
  }
  ```

### What's missing

1. **PKCE + OAuth flow module** — the actual OpenAI Codex OAuth login flow (port from pi-mono)
2. **Config store persistence** — store/retrieve codex_oauth as a secret config entry via `PUT /api/config` / `GET /api/config/resolved`
3. **Entrypoint restoration** — `docker-entrypoint.sh` codex branch: if no `OPENAI_API_KEY` and no `auth.json`, fetch `codex_oauth` from config store and write `~/.codex/auth.json`
4. **Adapter auto-refresh** — `codex-adapter.ts` should refresh expired tokens before creating a session (via `refreshAccessToken` + config store update + `auth.json` rewrite)
5. **CLI `codex-login` command** — Ink UI for running the OAuth flow from the terminal
6. **Onboarding integration** — add Codex as a harness choice with OAuth option
7. **Unit tests** — PKCE, flow, parsing, storage, adapter refresh

### Key Discoveries

- The `~/.codex/auth.json` format uses `auth_mode: "chatgpt"` with a nested `tokens` object containing `id_token`, `access_token`, `refresh_token`, and `account_id`. This is the exact format the Codex CLI reads natively.
- The Codex SDK's `env` option does NOT inherit from `process.env` (`codex-adapter.ts:781-793`). It's an explicit allowlist. The SDK reads `~/.codex/auth.json` directly when the Codex CLI binary starts up — we don't need to pass tokens through env vars.
- The entrypoint already fetches config store secrets at lines 200-223 and exports them as env vars. For `codex_oauth`, we need to parse the JSON value and write it to `~/.codex/auth.json` instead of exporting it as an env var (since it's a JSON blob, not a simple string).
- The `CLIENT_ID` (`app_EMoamEEZ73f0CkXaXp7hrann`) and OAuth endpoints are **public constants** from the Codex CLI — they're not secrets. They're the same values used by `codex login`.
- Pi-mono's `openai-codex.js` uses `node:http` for the loopback server. We need to use `Bun.serve` or the same `node:http` approach (Bun supports `node:http`). The plan uses `node:http` for cross-runtime compatibility, matching pi-mono's implementation exactly.
- The Codex CLI's `codex login --with-api-key` writes an `auth.json` with `auth_mode: "api_key"`, while `codex login` (browser OAuth) writes `auth_mode: "chatgpt"`. The CLI SDK prefers `auth.json` over `OPENAI_API_KEY` env var when both exist.

## Desired End State

A deployed Codex worker can authenticate via any of three paths:
1. `OPENAI_API_KEY` env var → entrypoint bootstraps `auth.json` via `codex login --with-api-key` (existing)
2. Pre-seeded `~/.codex/auth.json` volume mount (existing)
3. **NEW**: ChatGPT OAuth → `codex-login` CLI persists to config store → entrypoint restores at boot → adapter auto-refreshes when expired

The `codex-login` CLI command runs the OAuth PKCE flow (browser redirect to `localhost:1455`, manual paste fallback), extracts `chatgpt_account_id` from the JWT, and stores the credential in the swarm API config store. The entrypoint fetches it and writes `auth.json` in the exact format the Codex CLI expects.

### Key Discoveries (Implementation)

- `auth.json` format is `auth_mode: "chatgpt"` with nested `tokens: { id_token, access_token, refresh_token, account_id }` — we must match this exactly for the Codex CLI to read it natively.
- The entrypoint config-store fetch already exists at lines 200-223 but exports as env vars. For `codex_oauth`, we need a separate step that parses the JSON and writes it to `~/.codex/auth.json` with correct permissions (0600, owned by worker).
- Token refresh is needed because Codex access tokens expire (observed: `expires` ~6 hours from issuance). The adapter should refresh before session start and rewrite both config store and `auth.json`.

## Quick Verification Reference

Common commands to verify the implementation:
- `bun test src/tests/codex-oauth*.test.ts` — unit tests
- `bun run tsc:check` — type check
- `bun run lint:fix` — lint/format
- `bash scripts/check-db-boundary.sh` — DB boundary check
- `bun run src/cli.tsx help` — verify CLI includes `codex-login`
- `grep -R 'CLIENT_ID\|client_id' src/providers/codex-oauth/` — should only return public client id

Key files:
- `src/providers/codex-oauth/` — new module (flow.ts, pkce.ts, storage.ts, types.ts)
- `src/providers/codex-adapter.ts` — auto-refresh integration
- `src/commands/codex-login.tsx` — new CLI command
- `src/cli.tsx` — route registration + help text
- `docker-entrypoint.sh` — auth.json restoration from config store
- `src/commands/onboard/steps/harness.tsx` — add codex option
- `src/commands/onboard/env-generator.ts` — emit codex env vars

## What We're NOT Doing

- **In-browser OAuth from the dashboard** — the dashboard shows auth status and the CLI command to run, but the actual OAuth redirect flow happens in the terminal via `codex-login`. A full in-browser OAuth flow (which would require whitelisting a redirect URL with OpenAI) is a follow-up.
- **Onboarding wizard Codex harness step** — the Ink-based onboarding flow needs careful UI work; `codex-login` CLI is the v1 auth surface.
- **Multiple Codex accounts per swarm** — the config store key `codex_oauth` is global (not per-agent). If we need per-agent credentials later, we can add `codex_oauth:{agentId}` scoping.
- **SSE MCP transport for Codex** — out of scope (tracked in openai/codex#2129).
- **Modifying the Codex SDK** — we consume it as-is; no patches or forks.

## Implementation Approach

Port the pi-mono `openai-codex.js` OAuth flow into `src/providers/codex-oauth/`, adapting it to our types and runtime (Bun, `node:http` for loopback server). Persist credentials via the swarm API config store (not a local file — the key difference from pi-mono which uses `auth.json` + file locking). The entrypoint restores from config store to `~/.codex/auth.json` at boot. The adapter refreshes tokens at session start.

---

## Phase 1: PKCE Helper + OAuth Types

### Overview

Create the foundational PKCE module and shared TypeScript types for the OAuth flow. These are pure-utility modules with no side effects.

### Changes Required:

#### 1. PKCE utility
**File**: `src/providers/codex-oauth/pkce.ts` (new, ~35 lines)
**Changes**: Cross-runtime PKCE (works in Bun + Node) using Web Crypto API:
- `generatePKCE(): Promise<{ verifier: string; challenge: string }>`
- Generate 32-byte random verifier via `crypto.getRandomValues`, base64url-encode
- SHA-256 challenge via `crypto.subtle.digest`
- Identical algorithm to pi-mono's `pkce.js`

#### 2. OAuth types
**File**: `src/providers/codex-oauth/types.ts` (new, ~40 lines)
**Changes**:
```typescript
export type CodexOAuthCredentials = {
  access: string;       // access_token JWT
  refresh: string;      // refresh_token
  expires: number;      // absolute ms since epoch
  accountId: string;     // chatgpt_account_id from JWT claim
};

export type CodexOAuthCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
  signal?: AbortSignal;
};

// Shape matching ~/.codex/auth.json format for "chatgpt" auth_mode
export type CodexAuthJson = {
  auth_mode: "chatgpt";
  OPENAI_API_KEY: null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh: string; // ISO 8601
};
```

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [ ] PKCE produces distinct verifier/challenge pairs: `bun test src/tests/codex-oauth.test.ts`

#### Manual Verification:
- [ ] `generatePKCE()` verifier matches base64url spec (43 chars, URL-safe)
- [ ] `CodexAuthJson` type matches observed `~/.codex/auth.json` format exactly

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 1] codex oauth pkce + types`.

---

## Phase 2: OAuth Flow Implementation

### Overview

Port the core OAuth PKCE login flow from pi-mono's `openai-codex.js`. This includes the loopback server, token exchange, refresh, JWT decoding, and `chatgpt_account_id` extraction.

### Changes Required:

#### 1. OAuth flow module
**File**: `src/providers/codex-oauth/flow.ts` (new, ~320 lines)
**Changes**: Port from `node_modules/@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js`:
- Public constants: `CLIENT_ID`, `AUTHORIZE_URL`, `TOKEN_URL`, `REDIRECT_URI`, `SCOPE`, `JWT_CLAIM_PATH`
- `createState(): string` — 16-byte hex random via `node:crypto.randomBytes`
- `parseAuthorizationInput(input: string): { code?: string; state?: string }` — accepts bare code, `code=X&state=Y`, full URL, or `code#state`
- `decodeJwt(token: string): Record<string, unknown> | null` — base64 decode JWT payload
- `exchangeAuthorizationCode(code, verifier, redirectUri?): Promise<TokenResult>` — POST to `TOKEN_URL` with `grant_type=authorization_code`
- `refreshAccessToken(refreshToken: string): Promise<TokenResult>` — POST to `TOKEN_URL` with `grant_type=refresh_token`
- `getAccountId(accessToken: string): string | null` — extract `chatgpt_account_id` from JWT claim at `JWT_CLAIM_PATH`
- `loginCodexOAuth(callbacks: CodexOAuthCallbacks): Promise<CodexOAuthCredentials>` — full PKCE flow with loopback server on port 1455, manual paste fallback, token exchange, account ID extraction
- `startLocalOAuthServer(state: string)` — `node:http` server on `127.0.0.1:1455`, returns `{ close, cancelWait, waitForCode }`. On port conflict, resolves with no-op server and falls back to manual paste.
- `createAuthorizationFlow(originator?: string)` — generate PKCE + state + authorize URL with required Codex-specific params (`id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=agent-swarm`)

Mandatory authorize query params (verified against pi-mono reference):
- `response_type=code`, `code_challenge_method=S256`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=agent-swarm`

#### 2. Auth.json conversion utility
**File**: `src/providers/codex-oauth/auth-json.ts` (new, ~30 lines)
**Changes**:
- `credentialsToAuthJson(creds: CodexOAuthCredentials): CodexAuthJson` — converts our flat `CodexOAuthCredentials` into the exact `~/.codex/auth.json` format the Codex CLI expects
- `authJsonToCredentials(auth: CodexAuthJson): CodexOAuthCredentials` — reverse conversion (for reading existing auth.json)
- Note: `id_token` is not stored in `CodexOAuthCredentials` since the token exchange only gives us `access_token` and `refresh_token`. We write `access_token` into `id_token` as well (pi-mono doesn't store `id_token` either — the `codex login` flow stores it because OpenAI returns it from the initial authorize, but refresh only returns access + refresh). This matches what `codex login --with-api-key` produces: it creates an auth.json without `id_token`.
- **Verification needed**: Before implementing, verify that the Codex CLI accepts an auth.json where `id_token` equals `access_token`. If the CLI validates `id_token` as a separate JWT with specific claims, we may need to either store the original `id_token` from the OAuth response or omit it entirely. Check by running `codex` with a hand-crafted auth.json where `id_token = access_token`.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [ ] `parseAuthorizationInput` tests: `bun test src/tests/codex-oauth.test.ts`
- [ ] `decodeJwt` extracts `chatgpt_account_id` from a canned JWT
- [ ] `exchangeAuthorizationCode` constructs expected POST body (mocked `globalThis.fetch`)
- [ ] `refreshAccessToken` calls token endpoint with `grant_type=refresh_token`
- [x] `credentialsToAuthJson` produces exact format matching observed `~/.codex/auth.json`
- [x] `authJsonToCredentials` round-trips correctly

#### Manual Verification:
- [ ] Constants match pi-mono reference exactly (`CLIENT_ID`, URLs, scope)
- [ ] No secrets committed: `grep -R 'CLIENT_ID\|client_id' src/providers/codex-oauth/` returns only the public OpenAI client id

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 2] codex oauth flow + auth.json conversion`.

---

## Phase 3: Config Store Persistence + Adapter Auto-Refresh

### Overview

Wire credential persistence through the swarm API config store and add auto-refresh logic to the Codex adapter so expired tokens are refreshed before session start.

### Changes Required:

#### 1. Config store persistence
**File**: `src/providers/codex-oauth/storage.ts` (new, ~80 lines)
**Changes**:
- `storeCodexOAuth(apiUrl, apiKey, creds: CodexOAuthCredentials): Promise<void>` — `PUT /api/config` with `{ key: "codex_oauth", value: JSON.stringify(creds), scope: "global", isSecret: true }`
- `loadCodexOAuth(apiUrl, apiKey): Promise<CodexOAuthCredentials | null>` — `GET /api/config/resolved?includeSecrets=true`, parse `codex_oauth` field from global scope
- `deleteCodexOAuth(apiUrl, apiKey): Promise<void>` — `DELETE /api/config/{id}`
- `getValidCodexOAuth(apiUrl, apiKey): Promise<CodexOAuthCredentials | null>` — load, check `Date.now() >= expires`, refresh + re-store if expired, return null if refresh fails

#### 2. Adapter auto-refresh integration
**File**: `src/providers/codex-adapter.ts`
**Changes**: In `createSession()`, before constructing the `Codex` instance:
- If `process.env.OPENAI_API_KEY` is set → pass through as `env.OPENAI_API_KEY` (existing behavior, highest priority)
- Else, check if `~/.codex/auth.json` exists and is readable → if it contains `auth_mode: "chatgpt"`, check if tokens are expired → if expired, call `refreshAccessToken()` from `flow.ts`, rewrite `auth.json`, and update config store via `storeCodexOAuth()`
- If neither is available, call `getValidCodexOAuth(apiUrl, apiKey)` → if it returns credentials, write them to `~/.codex/auth.json` via `authJsonToCredentials` + `credentialsToAuthJson` + `fs.writeFileSync(authJsonPath, JSON.stringify(authJson), { mode: 0o600 })`
- If still no credentials → raise a clear error: `"No Codex credentials found. Run 'agent-swarm codex-login' or set OPENAI_API_KEY."`

The adapter needs `apiUrl` and `apiKey` from `config.env` (set by the runner from `MCP_BASE_URL` and `API_KEY`). Since `codex_oauth` is stored at global scope, `agentId` is not needed for credential lookup.

#### 3. Credential type update
**File**: `src/utils/credentials.ts`
**Changes**: Add `"CODEX_OAUTH"` to `CREDENTIAL_POOL_VARS` and add `"codex_oauth"` to `PROVIDER_CREDENTIAL_VARS.codex` as a secondary entry. Update `deriveProviderFromKeyType` to map `"CODEX_OAUTH"` → `"codex"`.

Note: `CODEX_OAUTH` is NOT an env var in the traditional sense — it's a config-store key stored at global scope. The credential pool mechanism is for tracking which credential was used for a task, not for env-var-based selection. The entrypoint writes `auth.json` from config store before the runner starts, so the adapter just needs to detect "we're using OAuth vs API key" for tracking purposes.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Storage tests pass: `bun test src/tests/codex-oauth-storage.test.ts`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] `storeCodexOAuth` PUT payload matches expected API config format
- [ ] `loadCodexOAuth` correctly parses `codex_oauth` from resolved config
- [ ] `getValidCodexOAuth` refreshes expired tokens and re-stores
- [ ] Adapter raises clear error when no credentials available

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 3] codex oauth config store + adapter auto-refresh`.

---

## Phase 4: Entrypoint Restoration

### Overview

Update `docker-entrypoint.sh` to restore `codex_oauth` from the config store into `~/.codex/auth.json` at boot, and update the config-store fetch to handle JSON-blob secrets that shouldn't be exported as env vars.

### Changes Required:

#### 1. Entrypoint codex auth branch update
**File**: `docker-entrypoint.sh`
**Changes**: Extend the codex auth branch (lines 13-38) to add a third auth path:

```bash
elif [ "$HARNESS_PROVIDER" = "codex" ]; then
    WORKER_CODEX_HOME="/home/worker/.codex"

    # Auth path 1: OPENAI_API_KEY → bootstrap via codex login --with-api-key
    if [ -n "${OPENAI_API_KEY:-}" ] && [ ! -f "$WORKER_CODEX_HOME/auth.json" ]; then
        mkdir -p "$WORKER_CODEX_HOME"
        chown -R worker:worker "$WORKER_CODEX_HOME" 2>/dev/null || true
        if gosu worker bash -c 'printenv OPENAI_API_KEY | codex login --with-api-key' >/dev/null 2>&1; then
            echo "Codex: registered OPENAI_API_KEY via 'codex login --with-api-key'"
        else
            echo "Warning: 'codex login --with-api-key' failed; worker may fail at first turn" >&2
        fi
    fi

    # Auth path 2: Restore codex_oauth from config store
    if [ ! -f "$WORKER_CODEX_HOME/auth.json" ] && [ -n "$API_KEY" ] && [ -n "$MCP_BASE_URL" ]; then
        CODEX_OAUTH=$(curl -sf -H "Authorization: Bearer ${API_KEY}" \
            "${MCP_BASE_URL}/api/config/resolved?includeSecrets=true" \
            2>/dev/null | jq -r '.configs[] | select(.key == "codex_oauth") | .value // empty' 2>/dev/null | head -1)
        if [ -n "$CODEX_OAUTH" ]; then
            if ! echo "$CODEX_OAUTH" | jq '.' >/dev/null 2>&1; then
                echo "Warning: codex_oauth from config store is not valid JSON, skipping" >&2
            else
                mkdir -p "$WORKER_CODEX_HOME"
                echo "$CODEX_OAUTH" | jq '.' > "$WORKER_CODEX_HOME/auth.json"
                chown worker:worker "$WORKER_CODEX_HOME/auth.json" 2>/dev/null || true
                chmod 600 "$WORKER_CODEX_HOME/auth.json"
                echo "[entrypoint] Restored codex OAuth credentials from API config store"
            fi
        fi
    fi

    # Fail if still no auth
    if [ ! -f "$WORKER_CODEX_HOME/auth.json" ]; then
        echo "Error: codex provider requires OPENAI_API_KEY, ~/.codex/auth.json, or codex_oauth in config store"
        exit 1
    fi
fi
```

Key differences from the existing Phase 6 plan draft:
- The config-store fetch now happens BEFORE the "fail if still no auth" check
- We parse the JSON value from the config response and write it directly to `auth.json` (not export as env var)
- We use `jq -r` to extract the value, then `jq '.'` to pretty-print it (validates it's valid JSON)
- Ownership is set to `worker:worker` (matching the existing `gosu worker` pattern)

#### 2. Config-store fetch handling (optional improvement)
**File**: `docker-entrypoint.sh`
**Changes**: The existing config-store fetch at lines 200-223 exports all config values as env vars. For `codex_oauth` (a JSON blob), exporting as env var would break shell parsing. Add a filter to skip JSON-blob values from env export:

```bash
# After the existing jq export, add a filter:
# Skip codex_oauth from env export — it's restored separately above
jq -r '.configs[] | select(.key != "codex_oauth") | "\(.key)=" + (.value | @sh)' /tmp/swarm_config.json > /tmp/swarm_config.env
```

This is a small safety improvement — currently `codex_oauth` won't exist in the config store yet, so this is forward-compatible.

### Success Criteria:

#### Automated Verification:
- [ ] Shell syntax check: `bash -n docker-entrypoint.sh`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`
- [ ] Docker build succeeds: `bun run docker:build:worker`

#### Manual Verification:
- [ ] Start a codex worker with `codex_oauth` in config store and no `OPENAI_API_KEY` → entrypoint restores `auth.json` and worker boots successfully
- [ ] Start a codex worker with no `OPENAI_API_KEY`, no `auth.json`, no `codex_oauth` → container exits with clear error message
- [ ] Start a codex worker with `OPENAI_API_KEY` (no `codex_oauth`) → existing bootstrap flow works (regression)
- [ ] Pre-seeded `auth.json` volume mount still works (regression)

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 4] docker entrypoint codex oauth restoration`.

---

## Phase 5: CLI `codex-login` Command + UI Integration

### Overview

Add the `codex-login` CLI command and integrate it into the dashboard UI so users can authenticate via ChatGPT OAuth both locally and for deployed swarms.

#### Local-to-deployed workflow

The primary user journey is:

1. **Local auth**: Run `agent-swarm codex-login` locally → browser OAuth → credentials stored in the swarm API config store
2. **Deployed workers pick up**: At boot, `docker-entrypoint.sh` fetches `codex_oauth` from the config store and writes `~/.codex/auth.json` → Codex CLI reads it natively

This means the user runs `codex-login` **once** against their swarm API server (which can be local or remote). The credentials are stored server-side in the config store. Every deployed worker with `HARNESS_PROVIDER=codex` and `AGENT_ID` set will automatically restore them at boot.

For users running a local swarm (`bun run start:http`), the defaults (`http://localhost:3013`) work out of the box. For remote swarms, pass `--api-url https://swarm.example.com`.

#### Dashboard UI integration

The dashboard (`new-ui/`) should surface two things for Codex workers:

1. **Credential status indicator**: On the agent detail page, show whether a codex worker has `OPENAI_API_KEY` (env var), `codex_oauth` (config store), or no auth configured. This uses the existing `GET /api/config/resolved?agentId=...&includeSecrets=true` endpoint — no new API needed.
2. **"Connect ChatGPT" button**: On agents with `HARNESS_PROVIDER=codex`, show a button that links to the `codex-login` CLI command or triggers an in-browser OAuth flow. The in-browser flow is a follow-up (it requires a redirect URL whitelist with OpenAI); for v1, the button shows the CLI command to run.

**v1 scope**: CLI command only. Dashboard credential status display is a quick addition (Phase 5). In-browser OAuth from the dashboard is explicitly out of scope for v1.

### Changes Required:

#### 1. Codex-login command
**File**: `src/commands/codex-login.tsx` (new, ~120 lines)
**Changes**: Ink-based CLI command:
- Parse args for `--api-url`, `--api-key` (with defaults from env)
- Call `loginCodexOAuth()` with callbacks:
  - `onAuth`: print URL to terminal, try `open` / `xdg-open` / `start` to open browser (fire-and-forget, non-fatal)
  - `onPrompt`: Ink text input for manual code paste
  - `onProgress`: `console.log` progress messages
  - `onManualCodeInput`: Ink text input (shown alongside browser flow as fallback)
- On success, call `storeCodexOAuth()` against the API config store
- Print success message with account ID and expiry
- Return exit code 0

#### 2. CLI routing
**File**: `src/cli.tsx`
**Changes**: Add `"codex-login"` to the command switch (before `render()` — this is a non-UI command that exits immediately). Add entry to `COMMAND_HELP`:
```
codex-login    Authenticate Codex via ChatGPT OAuth (browser or manual paste)
```

#### 3. Dashboard credential status (quick addition)
**File**: `new-ui/src/components/agent-detail.tsx` (or equivalent agent detail component)
**Changes**: For agents with `HARNESS_PROVIDER=codex`, display auth status:
- Check resolved config for `codex_oauth` key presence
- Show badge: "API Key" (if `OPENAI_API_KEY` is set), "ChatGPT OAuth" (if `codex_oauth` in config store), or "No Auth" (if neither)
- "Connect ChatGPT" button that shows the CLI command: `agent-swarm codex-login --api-url <url>`

This is a read-only display — no new API endpoints needed.

#### 4. Onboarding harness step (optional, follow-up)
**File**: `src/commands/onboard/steps/harness.tsx`
**Changes**: Add `codex` as a third harness option alongside `claude` and `pi`. When selected, offer:
1. "API key" — collect `OPENAI_API_KEY` (existing flow)
2. "Browser OAuth (ChatGPT subscription)" — invoke `loginCodexOAuth` inline

This is marked as a follow-up because the onboarding flow is Ink-based and needs careful UI work. The `codex-login` command is the primary auth surface for v1.

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] Help text lists the new command: `bun run src/cli.tsx help` includes `codex-login`

#### Manual Verification:
- [ ] Run `bun run src/cli.tsx codex-login` → browser opens, OAuth flow completes, credentials stored in config store
- [ ] Run with port 1455 occupied → manual paste fallback works
- [ ] Run with `--api-url http://localhost:3013 --api-key 123123` → stores to global config
- [ ] Dashboard shows "ChatGPT OAuth" badge on a codex agent with stored credentials
- [ ] Dashboard shows "Connect ChatGPT" button with correct CLI command

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 5] codex-login CLI command`.

---

## Phase 6: Tests

### Overview

Add comprehensive test coverage for the OAuth flow, storage, auth.json conversion, and entrypoint behavior.

### Changes Required:

#### 1. OAuth flow tests
**File**: `src/tests/codex-oauth.test.ts` (new)
**Changes**:
- PKCE generation produces distinct verifier/challenge pairs
- `parseAuthorizationInput` accepts all 4 paste formats (bare code, `code=X&state=Y`, full URL, `code#state`)
- `exchangeAuthorizationCode` constructs expected POST body (mock `globalThis.fetch`)
- `decodeJwt` extracts `chatgpt_account_id` from a canned JWT with the right claim shape
- `refreshAccessToken` re-invokes token endpoint with `grant_type=refresh_token`
- `getAccountId` returns null for JWT without claim
- `loginCodexOAuth` full flow with mocked loopback server

#### 2. Auth.json conversion tests
**File**: `src/tests/codex-oauth.test.ts` (same file)
**Changes**:
- `credentialsToAuthJson` produces exact format matching observed `~/.codex/auth.json`
- `authJsonToCredentials` round-trips correctly
- Missing optional fields handled gracefully

#### 3. Storage tests
**File**: `src/tests/codex-oauth-storage.test.ts` (new)
**Changes**:
- Mock `globalThis.fetch` and verify PUT/GET payloads match API config format
- `storeCodexOAuth` sends correct request body with `isSecret: true`
- `loadCodexOAuth` parses config response correctly
- `deleteCodexOAuth` sends DELETE request
- `getValidCodexOAuth` refreshes when expired, returns cached when valid, returns null when refresh fails

#### 4. Adapter auto-refresh tests
**File**: `src/tests/codex-oauth.test.ts` (same file)
**Changes**:
- Adapter with `OPENAI_API_KEY` set → skips OAuth entirely
- Adapter without `OPENAI_API_KEY` but with valid `auth.json` → uses file directly
- Adapter with expired `auth.json` → refreshes tokens, rewrites file
- Adapter with no credentials → raises clear error

#### 5. Entrypoint behavioral test
**File**: `src/tests/codex-entrypoint.test.ts` (new, optional)
**Changes**: Shell-based integration test that verifies the codex branch of `docker-entrypoint.sh`:
- With `OPENAI_API_KEY` → bootstraps auth.json
- Without `OPENAI_API_KEY` but with config store `codex_oauth` → restores auth.json
- Without either → exits with error

This is optional because testing shell scripts in Bun's test runner requires subprocess execution. The manual E2E verification covers this adequately.

### Success Criteria:

#### Automated Verification:
- [ ] All new tests pass: `bun test src/tests/codex-oauth.test.ts src/tests/codex-oauth-storage.test.ts`
- [ ] Full suite passes: `bun test`
- [ ] Type check passes: `bun run tsc:check`
- [ ] Lint passes: `bun run lint:fix`
- [ ] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] No secrets committed: `grep -R 'CLIENT_ID\|client_id' src/providers/codex-oauth/` returns only public client id
- [ ] Intentionally break a test (e.g., swap `CLIENT_ID`) and confirm it fails, then revert

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 6] codex oauth tests`.

---

## Phase 7: Docker Compose + Documentation

### Overview

Update docker-compose examples, documentation, and CLAUDE.md for the new OAuth auth path.

### Changes Required:

#### 1. Docker compose examples
**File**: `docker-compose.example.yml`
**Changes**: Add a comment in the codex-worker service block about the OAuth auth path:
```yaml
# Codex workers can authenticate via:
# 1. OPENAI_API_KEY (standard API billing)
# 2. Pre-seeded ~/.codex/auth.json volume mount
# 3. ChatGPT OAuth (run `agent-swarm codex-login` to store credentials)
# For OAuth, no OPENAI_API_KEY is needed — the entrypoint restores from config store.
```

#### 2. CLAUDE.md update
**File**: `CLAUDE.md`
**Changes**: In the "Local development" section, add `codex-login` to the key commands and mention the OAuth auth path. In the "Key env vars" section, add a note about `codex_oauth` config store key.

#### 3. CHANGELOG
**File**: `CHANGELOG.md`
**Changes**: Add entry: `feat(providers): add Codex ChatGPT OAuth support via codex-login command`

### Success Criteria:

#### Automated Verification:
- [ ] Shell syntax check: `bash -n docker-entrypoint.sh`
- [ ] Type check: `bun run tsc:check`
- [ ] Lint: `bun run lint:fix`
- [ ] Full test suite: `bun test`

#### Manual Verification:
- [ ] `docker-compose.example.yml` codex-worker block includes OAuth comment
- [ ] `bun run src/cli.tsx help` includes `codex-login`

**Implementation Note**: After completing this phase, pause for confirmation. Commit message: `[phase 7] codex oauth docs + compose examples`.

---

## Manual E2E

Run these commands against a real backend to verify the full OAuth flow works end-to-end:

```bash
# 0. Pre-flight: clean slate
rm -f agent-swarm-db.sqlite agent-swarm-db.sqlite-wal agent-swarm-db.sqlite-shm
bun run start:http &
sleep 2

# 1. Run codex-login (requires browser)
bun run src/cli.tsx codex-login --api-url http://localhost:3013 --api-key 123123

# 2. Verify credentials stored in config store
curl -sf -H "Authorization: Bearer 123123" \
  "http://localhost:3013/api/config/resolved?includeSecrets=true" | \
  jq '.configs[] | select(.key == "codex_oauth")'

# 3. Build worker image
bun run docker:build:worker

# 4. Start codex worker WITHOUT OPENAI_API_KEY (OAuth-only)
docker run --rm -d --name e2e-codex-oauth \
  --env-file .env.docker \
  -e HARNESS_PROVIDER=codex \
  -e MAX_CONCURRENT_TASKS=1 \
  -p 3205:3000 \
  agent-swarm-worker:latest

# 5. Verify entrypoint restored auth.json from config store
docker logs e2e-codex-oauth 2>&1 | grep "Restored codex OAuth"

# 6. Create and complete a task
AGENT_ID=$(curl -sf -H "Authorization: Bearer 123123" http://localhost:3013/api/agents | \
  jq -r '.agents[] | select(.isLead == false) | .id' | head -1)
TASK_ID=$(curl -sf -X POST http://localhost:3013/api/tasks \
  -H "Authorization: Bearer 123123" \
  -H "Content-Type: application/json" \
  -d "{\"description\": \"Say hi in one word\", \"agentId\": \"$AGENT_ID\"}" | jq -r '.task.id')

# 7. Poll for completion
for i in {1..12}; do
  STATUS=$(curl -sf -H "Authorization: Bearer 123123" http://localhost:3013/api/tasks/$TASK_ID | jq -r '.task.status')
  echo "status=$STATUS"
  [ "$STATUS" = "completed" ] && break
  sleep 5
done

# 8. Cleanup
docker stop e2e-codex-oauth
kill $(lsof -ti :3013) 2>/dev/null || true
```

**Expected outcomes:**
- Step 1: browser opens OAuth flow, credentials stored to config store
- Step 5: entrypoint log shows "Restored codex OAuth credentials from API config store"
- Step 7: task reaches `completed` status (ChatGPT subscription billing, not API key billing)

## Testing Strategy

- **Unit tests** — mock `globalThis.fetch` for token exchange, config store PUT/GET, and JWT decoding. Test PKCE, parsing, and auth.json conversion in isolation.
- **Integration tests** — `codex-login` command against a running API server with mock OAuth endpoint (deferred to follow-up if CI coverage is needed).
- **E2E tests** — manual commands documented above; a follow-up can add `scripts/e2e-codex-oauth.ts` mirroring `scripts/e2e-docker-provider.ts` if we want CI coverage.
- **Regression tests** — every phase verifies existing `OPENAI_API_KEY` auth path still works (docker builds, test suite, entrypoint validation).

## References

- Original Codex plan: `thoughts/taras/plans/2026-04-09-codex-app-server-support.md` (Phase 8, deferred)
- Pi-mono OAuth reference: `node_modules/@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js`
- Pi-mono PKCE reference: `node_modules/@mariozechner/pi-ai/dist/utils/oauth/pkce.js`
- Pi-mono auth storage: `node_modules/@mariozechner/pi-coding-agent/dist/core/auth-storage.js`
- Codex adapter: `src/providers/codex-adapter.ts`
- Entrypoint: `docker-entrypoint.sh`
- Credential tracking: `src/utils/credentials.ts`
- Config store API: `src/http/config.ts`, `src/tools/swarm-config/`
- Observed `~/.codex/auth.json` format on Taras's machine (this plan)

## Review Errata

_Reviewed: 2026-04-10 by Claude_

### Critical (resolved)
- [x] **Contradictory scoping** — "NOT Doing" section said `codex_oauth` is global, but Phase 3 storage.ts used `scope: "agent"`. Fixed: all storage/adapter code now uses `scope: "global"`, removing `agentId` from function signatures. Entrypoint no longer passes `X-Agent-ID` header or `agentId` query param for config fetch.

### Important (resolved)
- [x] **id_token handling ambiguous** — Added verification step to Phase 2: before implementing, verify that Codex CLI accepts auth.json where `id_token = access_token`. If not, store original `id_token` from OAuth response or omit it.
- [x] **No error handling for malformed JSON in entrypoint** — Added `jq '.'` validation before writing auth.json. If malformed, logs warning and falls through to "no auth" error instead of writing a corrupted file.

### Applied (auto-fixed)
- [x] Missing YAML frontmatter delimiters — added `---` delimiters with `date`, `planner`, `topic`, `status` fields
- [x] Entrypoint config fetch now uses global scope URL (removed `X-Agent-ID` header and `agentId` param)