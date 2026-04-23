---
date: 2026-04-23T00:00:00Z
topic: "Devin Harness Provider"
type: plan
status: completed
---

# Devin Harness Provider Implementation Plan

## Overview
Add a new harness provider backend for **Devin** (Cognition AI's software engineering agent). Unlike existing providers that run locally (Claude via CLI subprocess, Codex via in-process SDK, pi-mono via in-process AgentSession), the Devin provider interacts with a **remote cloud API** (Devin v3 REST API). Sessions run in Cognition's VMs, and the adapter bridges results back to the swarm via polling.

Key differentiators from other providers:
- **Playbook-based system prompt delivery** — system prompts are delivered as Devin playbooks (created via API, cached by content hash)
- **Skills via optional repo** — if `DEVIN_SKILLS_REPO` is configured, Devin auto-discovers `SKILL.md` files from the cloned repo; otherwise skills are inlined in the prompt
- **Session resume support** — suspended sessions (inactivity, user request, usage limits) are resumable via the "send message" API
- **Approval flow** — `waiting_for_approval` state maps to `request-human-input`, routable through Slack

## Current State Analysis

The harness provider system uses a Strategy pattern:

- **Interface**: `src/providers/types.ts` defines `ProviderAdapter`, `ProviderSession`, `ProviderSessionConfig`, `ProviderEvent` (10-type discriminated union), `ProviderResult`, and `CostData`.
- **Factory**: `src/providers/index.ts:16-27` — `createProviderAdapter()` switch on `"claude"` | `"pi"` | `"codex"`.
- **Runner**: `src/commands/runner.ts:2187` — instantiates adapter from `HARNESS_PROVIDER` env var, then the runner is fully provider-agnostic.
- **Credentials**: `src/utils/credentials.ts:21-26` — `PROVIDER_CREDENTIAL_VARS` maps provider names to their relevant env vars.
- **Docker**: `docker-entrypoint.sh:5` — defaults `HARNESS_PROVIDER` to `"claude"`, branches for credential validation per provider. `Dockerfile.worker:218` — `ENV HARNESS_PROVIDER=claude`.

### Key Discoveries:
- The `ProviderEvent` union (`src/providers/types.ts:18-40`) is the normalization target — all native events must map to this
- The runner (`src/commands/runner.ts:1673-1838`) processes events generically — no provider-specific code paths
- `PROVIDER_CREDENTIAL_VARS` (`src/utils/credentials.ts:21-26`) must include the new provider for credential pool filtering
- `deriveProviderFromKeyType()` (`src/utils/credentials.ts:36`) maps key env var names back to provider names
- Docker entrypoint (`docker-entrypoint.sh:5-80`) needs a new branch for Devin credential validation
- The MCP server integration is provider-specific (3 different wiring patterns) — Devin won't use MCP (accepted limited integration)
- System prompt delivery varies: Claude uses `--append-system-prompt`, Codex uses `AGENTS.md`, pi-mono uses `appendSystemPrompt` SDK param — Devin will use **playbooks**
- Devin supports skills via `SKILL.md` files in repos (paths: `.cognition/skills/`, `.claude/skills/`, etc.) — auto-discovered at session start
- Devin playbooks can be created via API (`POST /v3/organizations/{org_id}/playbooks`) and attached to sessions via `playbook_id`

### Devin API Characteristics:
- **Auth**: Bearer token (`DEVIN_API_KEY`, prefix `cog_*`) + organization ID (`DEVIN_ORG_ID`, prefix `org-*`)
- **Create session**: `POST /v3/organizations/{org_id}/sessions` with `prompt`, `repos`, `playbook_id`, `structured_output_schema`, `tags`, etc.
- **Poll session**: `GET /v3/organizations/{org_id}/sessions/{devin_id}` — returns `status`, `status_detail`, `structured_output`, `pull_requests`, `acus_consumed`
- **Send message**: `POST /v3/organizations/{org_id}/sessions/{devin_id}/messages` — follow-up messages, auto-resumes suspended sessions
- **Create playbook**: `POST /v3/organizations/{org_id}/playbooks` — `title` + `body`, returns `playbook_id`
- **No streaming**: Polling only (no SSE, WebSocket, or webhook callbacks)
- **Cost model**: ACU-based (~$2.00-2.25/ACU, 1 ACU ≈ 15 min active work). Map to `totalCostUsd` directly.
- **Session states**: `new` → `creating` → `claimed` → `running` → `exit`/`error`/`suspended`. Suspended sessions are resumable.
- **Skills**: Discovered from `SKILL.md` files in cloned repos (7 supported paths including `.cognition/skills/` and `.claude/skills/`)
- **Workspace**: Remote VM — repos specified via `repos` field or prompt context

## Desired End State

Running `HARNESS_PROVIDER=devin bun run src/cli.tsx worker` connects to the swarm, picks up tasks, creates Devin sessions via the v3 API, polls for completion, and reports progress/cost/results back to the swarm. The provider:

1. Delivers the system prompt as a Devin playbook (cached — avoids re-creation when prompt unchanged)
2. Creates Devin sessions with the task prompt + playbook_id + optional repos
3. If `DEVIN_SKILLS_REPO` is set, includes it in the session's repos so Devin auto-discovers skills
4. Polls for status changes and emits normalized `ProviderEvent`s
5. Reports ACU-based cost as `totalCostUsd` in `CostData`
6. Supports session resume (`canResume() = true` for non-terminal states)
7. Maps `waiting_for_approval` to `request-human-input` (routable through Slack)
8. Supports session abort via the API
9. Does NOT require MCP (accepted limited integration — adapter handles lifecycle)
10. Works in Docker with credential validation in the entrypoint

**Verification**: `HARNESS_PROVIDER=devin DEVIN_API_KEY=<key> DEVIN_ORG_ID=<org> bun run src/cli.tsx worker` starts, picks up a task, creates a Devin session, polls to completion, and reports results.

## Quick Verification Reference

Common commands:
- `bun run lint:fix` — Lint & format
- `bun run tsc:check` — Type check
- `bun test` — All unit tests
- `bun test src/tests/devin-adapter.test.ts` — Devin-specific tests
- `bash scripts/check-db-boundary.sh` — DB boundary check

Key files:
- `src/providers/devin-adapter.ts` — Core adapter + session implementation
- `src/providers/devin-api.ts` — Devin v3 REST API client
- `src/providers/devin-playbooks.ts` — Playbook caching for system prompt delivery
- `src/providers/index.ts` — Factory registration
- `src/utils/credentials.ts` — Credential pool mapping
- `docker-entrypoint.sh` — Docker credential validation
- `src/tests/devin-adapter.test.ts` — Unit tests

## What We're NOT Doing

- **MCP integration**: Devin runs in Cognition's cloud and cannot connect to our MCP server. The adapter handles task lifecycle (progress, completion) by polling. Devin works independently on tasks.
- **Devin CLI installation in Docker**: Devin is a cloud API, not a local binary. No CLI to install.
- **OAuth login command**: Devin uses simple API keys (no PKCE flow needed).
- **Model selection**: Devin doesn't expose model selection — it uses its own model internally.
- **Devin's knowledge system**: Knowledge notes are out of scope (playbooks cover system prompt delivery).

## Implementation Approach

The Devin adapter follows the same Strategy pattern as existing providers but with a **polling-based event loop** instead of stream parsing. The implementation is split into:

- **`devin-api.ts`** — Thin REST client for Devin v3 endpoints
- **`devin-playbooks.ts`** — Playbook creation + caching (hash-based dedup to avoid re-creating unchanged system prompts)
- **`devin-adapter.ts`** — `DevinAdapter` + `DevinSession` implementing the provider interfaces

Key design choices:
- **Playbook caching**: Hash the system prompt content → check if we already have a playbook_id for that hash (stored in adapter instance memory, keyed by SHA-256 of content). If yes, reuse. If no, create via API.
- **Skills delivery**: If `DEVIN_SKILLS_REPO` env var is set, include it in the session's `repos` array so Devin auto-discovers `SKILL.md` files. Otherwise, inline skill content in the prompt text.
- **Session resume**: `canResume()` calls `getSession()` and returns `true` if status is not `exit` or `error`. The runner can resume by sending a message to the session.
- **Approval flow**: When polling detects `waiting_for_approval`, emit a human input request via the swarm API. If Slack is configured, the request routes there. When the user responds, send the response as a message to Devin's session.
- **Cost mapping**: ACU → USD via configurable rate (`DEVIN_ACU_COST_USD`, default: `2.25`).

---

## Phase 1: Core Adapter Scaffold + API Client

### Overview
Create the Devin v3 REST API client and the adapter/session classes implementing `ProviderAdapter` and `ProviderSession`. This phase establishes the complete structure with a functional polling loop.

### Changes Required:

#### 1. Devin API Client
**File**: `src/providers/devin-api.ts` (new)
**Changes**: Create a typed REST client for Devin v3 endpoints:

**Types:**
```typescript
type DevinSessionStatus = "new" | "creating" | "claimed" | "running" | "exit" | "error" | "suspended" | "resuming";
type DevinStatusDetail = "working" | "waiting_for_user" | "waiting_for_approval" | "finished" | "inactivity" | "user_request" | "usage_limit_exceeded" | "out_of_credits";

interface DevinSessionCreateRequest {
  prompt: string;
  playbook_id?: string;
  repos?: string[];
  structured_output_schema?: object;
  tags?: string[];
  title?: string;
  max_acu_limit?: number;
  bypass_approval?: boolean;
  session_secrets?: Array<{ key: string; value: string; sensitive?: boolean }>;
}

interface DevinSessionResponse {
  session_id: string;
  url: string;
  status: DevinSessionStatus;
  status_detail?: DevinStatusDetail;
  structured_output?: unknown;
  pull_requests?: Array<{ pr_url: string; pr_state: string }>;
  acus_consumed?: number;
  title?: string;
  tags?: string[];
  created_at: number;
  updated_at: number;
}

interface DevinPlaybookCreateRequest { title: string; body: string; }
interface DevinPlaybookResponse { playbook_id: string; title: string; body: string; }
```

**Functions:**
- `createSession(orgId, apiKey, request)` — `POST /v3/organizations/{orgId}/sessions`
- `getSession(orgId, apiKey, sessionId)` — `GET /v3/organizations/{orgId}/sessions/{sessionId}`
- `sendMessage(orgId, apiKey, sessionId, message)` — `POST /v3/organizations/{orgId}/sessions/{sessionId}/messages`
- `archiveSession(orgId, apiKey, sessionId)` — archive endpoint to terminate
- `createPlaybook(orgId, apiKey, request)` — `POST /v3/organizations/{orgId}/playbooks`
- Base URL: `https://api.devin.ai` (overridable via `DEVIN_API_BASE_URL` for testing)
- Auth: `Authorization: Bearer ${apiKey}`
- Error handling for 4xx/5xx with typed error responses

#### 2. Devin Adapter
**File**: `src/providers/devin-adapter.ts` (new)
**Changes**: Implement `ProviderAdapter` and `ProviderSession`:

**`DevinAdapter` class:**
- `name = "devin"`
- Private `playbookCache: Map<string, string>` — maps SHA-256 hash of system prompt → `playbook_id`
- `createSession(config)`:
  1. Validate `DEVIN_API_KEY` and `DEVIN_ORG_ID` from `config.env` or `process.env`
  2. If `config.systemPrompt` is non-empty, resolve playbook_id via cache or create new playbook
  3. Build `repos` array from `DEVIN_REPOS` env var (comma-separated) + `DEVIN_SKILLS_REPO` if set
  4. If no skills repo but prompt references a skill, inline skill content in prompt
  5. Call Devin API to create session with prompt, playbook_id, repos
  6. Return `DevinSession`
- `canResume(sessionId)`: Call `getSession()`, return `true` if status is not `exit` or `error`
- `formatCommand(name)`: Returns `@skills:${name}`

**`DevinSession` class:**
- `sessionId`: Set from Devin's `session_id` response (format: `devin-*`)
- `onEvent(listener)`: Standard listener registration with queued replay for late subscribers
- `waitForCompletion()`: Returns a promise that resolves when polling detects a terminal state
- `abort()`: Calls Devin API to archive the session
- Private `startPolling()`: Runs on an interval (configurable via `DEVIN_POLL_INTERVAL_MS`, default: `15000`ms)
- Private state tracking: `lastStatus`, `lastStatusDetail`, `lastStructuredOutput` (JSON string for comparison), `seenPrUrls: Set<string>`
- Session log writing: Opens `Bun.file(config.logFile).writer()`, writes all events as JSONL with `scrubSecrets`
- Cleanup: Clears polling interval and closes log writer in `finally`

**Terminal states** (resolve `waitForCompletion`):
- `exit` — success
- `error` — failure (but resumable via `canResume`)
- `suspended` — failure (but resumable via `canResume`)
- `running` + `finished` detail — success

**CostData mapping:**
```typescript
const acuCostUsd = Number(process.env.DEVIN_ACU_COST_USD) || 2.25;
const cost: CostData = {
  sessionId: this.sessionId!,
  taskId: config.taskId,
  agentId: config.agentId,
  totalCostUsd: (response.acus_consumed ?? 0) * acuCostUsd,
  inputTokens: 0,   // Devin doesn't expose token counts
  outputTokens: 0,
  durationMs: Date.now() - this.startTime,
  numTurns: this.pollCount,
  model: "devin",
  isError: response.status === "error" || response.status === "suspended",
};
```

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Files exist: `ls src/providers/devin-adapter.ts src/providers/devin-api.ts`
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Review that `DevinAdapter` implements all `ProviderAdapter` methods
- [ ] Review that `DevinSession` implements all `ProviderSession` methods
- [ ] Review that playbook caching logic uses content hash correctly
- [ ] Review that `scrubSecrets` is applied to all logged content

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Provider Registration & Credentials

### Overview
Wire the Devin adapter into the factory, credential system, and type definitions so `HARNESS_PROVIDER=devin` is recognized throughout the codebase.

### Changes Required:

#### 1. Factory Registration
**File**: `src/providers/index.ts`
**Changes**:
- Import `DevinAdapter` from `./devin-adapter`
- Add `case "devin": return new DevinAdapter();` to the switch in `createProviderAdapter()`
- Update the error message to include `"devin"` in the supported list

#### 2. Credential Pool Mapping
**File**: `src/utils/credentials.ts`
**Changes**:
- Add to `CREDENTIAL_POOL_VARS` array: `"DEVIN_API_KEY"`
- Add to `PROVIDER_CREDENTIAL_VARS`: `devin: ["DEVIN_API_KEY"]`
- Add to `deriveProviderFromKeyType()`: `case "DEVIN_API_KEY": return "devin";`

#### 3. Type Definitions (if applicable)
**File**: `src/types.ts`
**Changes**: Check if there's a `HarnessProvider` type union. If so, add `"devin"`. If not (providers are just strings), skip this.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test` (8 pre-existing GitLab failures, 0 new)
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`
- [x] Grep confirms registration: `grep -n "devin" src/providers/index.ts`

#### Manual Verification:
- [ ] `createProviderAdapter("devin")` would return a `DevinAdapter` instance
- [ ] Error message for unknown providers now includes "devin" in the list
- [ ] Credential vars for devin are correctly mapped

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 3: Event Translation, Resume & Approval Flow

### Overview
Flesh out the polling-to-event translation layer with full status state machine handling, session resume support, and the `waiting_for_approval` → `request-human-input` flow.

### Changes Required:

#### 1. Status State Machine
**File**: `src/providers/devin-adapter.ts`
**Changes**: Implement detailed status-to-event mapping in the polling loop:

**Devin status transitions and corresponding events:**

| Devin Status | Status Detail | ProviderEvent(s) | Terminal? |
|---|---|---|---|
| `new` / `creating` / `claimed` | — | `custom { name: "devin.status", data: { status, detail } }` | No |
| `running` | `working` | `custom { name: "devin.status", data: { status: "running", detail: "working" } }` | No |
| `running` | `waiting_for_user` | `custom { name: "devin.waiting", data: { reason: "user_input" } }` + `message { role: "assistant", content: "Devin is waiting for user input" }` | No |
| `running` | `waiting_for_approval` | `custom { name: "devin.approval_needed" }` + **trigger `request-human-input`** via swarm API (see below) | No (blocks until approval) |
| `running` | `finished` | `result { cost, output, isError: false }` | **Yes (success)** |
| `exit` | — | `result { cost, output: structuredOutput, isError: false }` | **Yes (success)** |
| `error` | — | `error { message }` then `result { cost, isError: true, errorCategory: "devin_error" }` | **Yes (failure, resumable)** |
| `suspended` | `inactivity` | `message { role: "assistant", content: "Devin suspended: inactivity" }` then `result { isError: true, errorCategory: "suspended_inactivity" }` | **Yes (failure, resumable)** |
| `suspended` | `user_request` | `result { isError: true, errorCategory: "suspended_user" }` | **Yes (failure, resumable)** |
| `suspended` | `usage_limit_exceeded` | `error { message: "ACU limit exceeded" }` then `result { isError: true, errorCategory: "suspended_cost" }` | **Yes (failure, resumable after limit increase)** |
| `suspended` | `out_of_credits` | `error { message: "Out of Devin credits" }` then `result { isError: true, errorCategory: "suspended_cost" }` | **Yes (failure, resumable after credits added)** |
| `resuming` | — | `custom { name: "devin.status", data: { status: "resuming" } }` | No |

**Key distinction**: `suspended` states are terminal for the current session run (resolve `waitForCompletion` with `isError: true`) but `canResume()` returns `true`, allowing the runner to retry by sending a message.

#### 2. Approval Flow (`waiting_for_approval`)
**File**: `src/providers/devin-adapter.ts`
**Changes**: When polling detects `status_detail === "waiting_for_approval"`:

1. Emit `custom { name: "devin.approval_needed", data: { sessionId, sessionUrl } }`
2. Call the swarm API to create a human input request:
   ```
   POST {apiUrl}/api/tasks/{taskId}/human-input
   { "question": "Devin is waiting for approval. Review at: {sessionUrl}", "source": "devin" }
   ```
3. Continue polling — when the human responds (via dashboard or Slack), the swarm delivers the response back. The adapter picks up the response and sends it as a message to Devin's session via `sendMessage()`.
4. Devin auto-resumes and the status changes from `waiting_for_approval` to `working`.

**Note**: The existing `request-human-input` MCP tool already integrates with Slack. When a user responds in Slack, the swarm stores the response. We need to poll for that response and relay it to Devin.

#### 3. Structured Output & PR Tracking
**File**: `src/providers/devin-adapter.ts`
**Changes**:
- On each poll, compare `structured_output` (JSON-stringified) with previous value. If changed, emit `custom { name: "devin.structured_output", data: response.structured_output }`
- On each poll, check `pull_requests` array for new entries not in `seenPrUrls`. For each new PR, emit `custom { name: "devin.pull_request", data: { url, state } }`
- On terminal success, use `structured_output` as the `output` field in the `result` event (JSON-stringified)

#### 4. Progress Reporting
**File**: `src/providers/devin-adapter.ts`
**Changes**: On each significant status change, emit `message { role: "assistant", content: statusSummary }` so the runner's auto-progress picks it up. Include Devin session URL for dashboard visibility.

#### 5. Session Log Writing
**File**: `src/providers/devin-adapter.ts`
**Changes**: Ensure every emitted event is also written to the JSONL log file:
- Open `Bun.file(config.logFile).writer()` in constructor
- Each `emit()` also writes `JSON.stringify(scrubSecrets(event)) + "\n"` to the writer
- Close writer in `finally` block

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test` (8 pre-existing GitLab failures, 0 new)

#### Manual Verification:
- [ ] Review the status-to-event mapping covers all Devin states
- [ ] Review that `canResume()` correctly identifies resumable sessions
- [ ] Review the approval flow: detect `waiting_for_approval` → request human input → poll for response → relay to Devin
- [ ] Review that `structured_output` changes are detected and emitted
- [ ] Review that pull request events are emitted for new PRs
- [ ] Review that all log content passes through `scrubSecrets`

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 4: Docker Integration

### Overview
Add Devin-specific credential validation and binary checks to the Docker entrypoint. Since Devin is a cloud API (no local binary), this is simpler than other providers.

### Changes Required:

#### 1. Docker Entrypoint
**File**: `docker-entrypoint.sh`
**Changes**: Add a Devin branch to the credential validation section (after the codex block, before the default claude block):

```bash
elif [ "$HARNESS_PROVIDER" = "devin" ]; then
    # Devin auth: DEVIN_API_KEY and DEVIN_ORG_ID must exist
    if [ -z "$DEVIN_API_KEY" ]; then
        echo "Error: DEVIN_API_KEY is required for Devin provider"
        exit 1
    fi
    if [ -z "$DEVIN_ORG_ID" ]; then
        echo "Error: DEVIN_ORG_ID is required for Devin provider"
        exit 1
    fi
    echo "Devin API: configured (org: ${DEVIN_ORG_ID})"
```

Also update the binary verification section — Devin needs no local binary check:

```bash
elif [ "$HARNESS_PROVIDER" = "devin" ]; then
    echo "Devin: cloud API (no local binary required)"
```

#### 2. Docker Environment Variables
**File**: `.env.docker.example`
**Changes**: Add commented Devin env vars:
```
# Devin provider
# DEVIN_API_KEY=cog_...
# DEVIN_ORG_ID=org-...
# DEVIN_POLL_INTERVAL_MS=15000
# DEVIN_ACU_COST_USD=2.25
# DEVIN_REPOS=owner/repo1,owner/repo2
# DEVIN_SKILLS_REPO=owner/skills-repo
```

### Success Criteria:

#### Automated Verification:
- [x] Entrypoint syntax valid: `bash -n docker-entrypoint.sh`
- [x] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] Review that the Devin branch correctly validates both `DEVIN_API_KEY` and `DEVIN_ORG_ID`
- [ ] Review that the binary check section skips gracefully for Devin
- [ ] Review that `.env.docker.example` includes Devin vars with documentation

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 5: Playbooks, Skills & System Prompt Delivery

### Overview
Implement playbook-based system prompt delivery and skill support. Playbooks are created via the Devin API and cached by content hash to avoid re-creation when the system prompt hasn't changed. Skills are delivered via an optional skills repo or inlined in the prompt.

### Changes Required:

#### 1. Playbook Cache
**File**: `src/providers/devin-playbooks.ts` (new)
**Changes**: Create a helper module for playbook management:

```typescript
// In-memory cache: SHA-256 hash of body → playbook_id
const playbookCache = new Map<string, string>();

async function getOrCreatePlaybook(
  orgId: string, apiKey: string, title: string, body: string
): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const cached = playbookCache.get(hash);
  if (cached) return cached;

  const response = await createPlaybook(orgId, apiKey, { title, body });
  playbookCache.set(hash, response.playbook_id);
  return response.playbook_id;
}
```

The cache is per-adapter-instance (per worker boot). On worker restart, playbooks are re-created (Devin likely deduplicates server-side, and the overhead is one API call per boot).

#### 2. System Prompt → Playbook
**File**: `src/providers/devin-adapter.ts`
**Changes**: In `DevinAdapter.createSession()`:

```typescript
let playbookId: string | undefined;
if (config.systemPrompt) {
  playbookId = await getOrCreatePlaybook(
    orgId, apiKey,
    `swarm-system-prompt-${config.agentId}`,
    config.systemPrompt
  );
}
```

Pass `playbookId` in the session creation request.

#### 3. Skills Delivery
**File**: `src/providers/devin-adapter.ts`
**Changes**: In `DevinAdapter.createSession()`:

```typescript
const repos: string[] = [];

// Add user-specified repos
const devinRepos = process.env.DEVIN_REPOS;
if (devinRepos) repos.push(...devinRepos.split(",").map(r => r.trim()));

// Add skills repo — Devin will auto-discover SKILL.md files from it
const skillsRepo = process.env.DEVIN_SKILLS_REPO;
if (skillsRepo) repos.push(skillsRepo);
```

If no `DEVIN_SKILLS_REPO` is set and the prompt references a skill (detected by `formatCommand()` output in the prompt), the skill content is already inlined by the runner's prompt composition.

#### 4. Slash Command Formatting
**File**: `src/providers/devin-adapter.ts`
**Changes**: `formatCommand(name)` returns `@skills:${name}` — this is Devin's native skill invocation syntax. When Devin has the skill available (via skills repo), it will auto-invoke using this format.

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test` (8 pre-existing GitLab failures, 0 new)

#### Manual Verification:
- [ ] Review that playbook caching avoids re-creating unchanged system prompts
- [ ] Review that `DEVIN_SKILLS_REPO` is included in session repos when set
- [ ] Review that `formatCommand()` returns Devin's native `@skills:name` format
- [ ] Review that repos from `DEVIN_REPOS` and `DEVIN_SKILLS_REPO` are correctly merged
- [ ] E2E test: Create a session and verify the playbook_id is attached

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 6: Tests & Documentation

### Overview
Write unit tests for the Devin adapter, API client, and playbook caching. Update documentation to reflect the new provider.

### Changes Required:

#### 1. API Client Tests
**File**: `src/tests/devin-api.test.ts` (new)
**Changes**: Test the Devin API client with mocked HTTP responses:
- Session creation — success and error cases
- Session polling — all status/status_detail combinations
- Session message sending
- Session archival
- Playbook creation
- Auth header construction
- Error handling for 4xx/5xx responses

#### 2. Adapter Tests
**File**: `src/tests/devin-adapter.test.ts` (new)
**Changes**: Test the adapter's behavior:
- `createSession()` validates required env vars (`DEVIN_API_KEY`, `DEVIN_ORG_ID`)
- `createSession()` creates playbook from system prompt and attaches to session
- Playbook cache returns existing playbook_id for same content hash
- Polling loop emits correct `ProviderEvent` sequence for full lifecycle (new → running → exit)
- Polling handles `waiting_for_approval` → human input request → message relay
- Polling handles all suspended states with correct error categories
- `canResume(sessionId)` returns `true` for suspended, `false` for exit/error
- `abort()` calls archive API
- `CostData` maps ACUs correctly with default and custom `DEVIN_ACU_COST_USD`
- `formatCommand()` returns `@skills:name` format
- `scrubSecrets` is applied to all log writes
- Structured output changes detected and emitted as custom events
- Pull request events emitted for new PRs
- `DEVIN_REPOS` and `DEVIN_SKILLS_REPO` are correctly passed to session creation
- Use a mock HTTP server (minimal `node:http` handler) for API responses
- Isolated test DB is NOT needed (Devin adapter doesn't touch SQLite)

#### 3. Documentation Updates
**File**: `CLAUDE.md`
**Changes**:
- Add `devin` to the `HARNESS_PROVIDER` values list in the local development section
- Add Devin-specific env vars: `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `DEVIN_POLL_INTERVAL_MS`, `DEVIN_ACU_COST_USD`, `DEVIN_REPOS`, `DEVIN_SKILLS_REPO`, `DEVIN_API_BASE_URL`
- Document: Devin uses playbooks for system prompt delivery, supports session resume, maps `waiting_for_approval` to `request-human-input`
- Note: Devin has no MCP integration — works independently on tasks, adapter bridges results

### Success Criteria:

#### Automated Verification:
- [x] Type check passes: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test` (8 pre-existing GitLab failures, 0 new)
- [x] Devin-specific tests pass: `bun test src/tests/devin-adapter.test.ts src/tests/devin-api.test.ts` (39/39 pass)
- [x] DB boundary check: `bash scripts/check-db-boundary.sh`

#### Manual Verification:
- [ ] Review test coverage for all Devin status states including resume scenarios
- [ ] Review test coverage for playbook caching
- [ ] Review that `CLAUDE.md` accurately documents Devin provider setup
- [ ] E2E test: `HARNESS_PROVIDER=devin DEVIN_API_KEY=<key> DEVIN_ORG_ID=<org> bun run src/cli.tsx worker` starts and polls for tasks
- [ ] E2E test: Create a trivial task, verify Devin session is created with playbook and polled to completion
- [ ] E2E test: Cancel a task via API, verify Devin session is archived
- [ ] E2E test: Verify `canResume()` returns true for a suspended session

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Testing Strategy

**Unit tests** (in `src/tests/`):
- `devin-api.test.ts` — API client with mocked HTTP (session CRUD, playbook CRUD, error handling)
- `devin-adapter.test.ts` — Event translation, lifecycle, cost mapping, playbook caching, resume, approval flow

**No SQLite needed**: The Devin adapter is worker-side code — it must NOT import from `src/be/db` (enforced by `check-db-boundary.sh`). Tests use a mock HTTP server for Devin API responses, not a database.

**E2E testing**: With real `DEVIN_API_KEY` and `DEVIN_ORG_ID`, run the worker and assign a trivial task. Verify:
1. Playbook creation (system prompt delivered as playbook)
2. Session creation with playbook_id and repos
3. Polling works (status updates appear in logs)
4. Completion is detected (task marked done in swarm)
5. Abort works (cancelling task archives Devin session)
6. Resume works (suspended session can be resumed via message)
7. Cost is reported (ACU → USD in task cost data)
8. Approval flow works (waiting_for_approval → human input → relay to Devin)

## References
- Devin v3 API docs: https://docs.devin.ai/api-reference/overview
- Devin session creation: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
- Devin playbooks API: https://docs.devin.ai/api-reference/v3/playbooks/post-organizations-playbooks
- Devin skills: https://docs.devin.ai/product-guides/skills
- Harness provider guide: https://docs.agent-swarm.dev/docs/guides/harness-providers
- Existing providers: `src/providers/claude-adapter.ts`, `src/providers/codex-adapter.ts`, `src/providers/pi-mono-adapter.ts`
- Provider types: `src/providers/types.ts`
