# Secret scrubbing runbook

Centralized scrubber for any path that emits to logs, stdout/stderr, the `session_logs` table, or `/workspace/logs/*.jsonl`.

## Rule

Never print raw env values, credential-pool entries, OAuth payloads, webhook bodies, or tool output that may embed tokens. Wrap output through `scrubSecrets` at the **egress** point, not the source.

```ts
import { scrubSecrets } from "./utils/secret-scrubber";
console.log(scrubSecrets(maybeContainsToken));
```

Module: `src/utils/secret-scrubber.ts`.

## Cache refresh

After reloading `swarm_config` or rotating credential pools, call `refreshSecretScrubberCache()` so newly-added secrets get covered. `/internal/reload-config` and worker credential-selection already do this.

Secret `swarm_config` writes also register the new plaintext with the scrubber synchronously before the write call returns. This closes the in-process window between rotating a secret and persisting task output or rendering an automatic Slack completion that contains it. Callers adding another runtime secret source must likewise call `registerVolatileSecret(value, name)` at the successful write/rotation boundary. On the API, a new *stored* (encrypted) secret source calls `registerStoredSecret(value, name)` from `src/be/secret-registry.ts` at its encrypt site instead, and adds a loader to `loadSecretRegistry()`.

## Secret registry (API)

`src/be/secret-registry.ts` loads every stored secret at API boot, before listen and before the retro-sweep: secret `swarm_config` rows of all scopes (incl. `connection.<slug>.secret`), OAuth app client secrets and authorization tokens (provider and MCP apps share these tables), and script API bearer tokens. Each value is registered with its base64, base64url (incl. offset-shifted windows, e.g. inside `Basic` auth) and URL-encoded forms through `registerVolatileSecret`. Markers are `config:<KEY>`, `oauth:<provider>:<client_secret|access_token|refresh_token>` and `script-api:<id>`. The registry is append-only: deleted or rotated values stay registered. A row that cannot be decrypted is counted and skipped; the boot log line `[secret-registry] registered config=… oauth=… scriptApi=… failed=…` carries counts only.

Volatile registration is process-local. It does not update another already-running API or worker process. Cross-process coverage begins only after that process reloads the config or otherwise learns and registers the new value; deployments with multiple API replicas must coordinate reloads when rotating shared secrets.

## Coverage

The scrubber is worker/API-neutral: it reads `process.env` and its process-local volatile registry, but never accesses the database. It is safe to import from either side without violating the DB boundary.

It covers:

- **Env-sourced values:** any env value ≥12 chars exact-match, plus comma-separated pool components.
- **Runtime config values:** successful secret `swarm_config` writes register values ≥12 chars for immediate, process-local exact-match scrubbing.
- **Stored secrets (API only):** every value the secret registry loads at boot or registers at a write, plus its encoded forms.

All known values (env and volatile) are matched by one combined, longest-first alternation regex, rebuilt lazily when either set changes, so the cost stays flat as the set grows.
- **Structural patterns:** GitHub PATs, ACP session tokens (`aseph_`), Anthropic/OpenAI/OpenRouter `sk-*`, Slack `xox*`, JWTs, AWS access keys, Google API keys.

## Adding a new secret shape

1. Extend `SENSITIVE_KEY_EXACT` (env-key match) or `TOKEN_REGEXES` (structural pattern) in `src/utils/secret-scrubber.ts`.
2. Add a regression test in `src/tests/secret-scrubber.test.ts`.
3. Bump `SCRUBBER_RULES_VERSION` (see Retro-sweep).

## Retro-sweep

A new rule protects only rows written after it ships. `src/be/boot-scrub-sweep.ts` re-scrubs stored rows once per `SCRUBBER_RULES_VERSION`, so **bump the version on every rule change** (key, suffix, regex, pass, or threshold).

- Runs after the API starts listening, fire-and-forget. Done marker: `seed_state(kind='maintenance', key='boot-scrub-v<N>')`. Per-table resume cursor: `boot-scrub-v<N>:<table>:cursor`.
- Swept columns, in order: `session_logs.content`; `agent_tasks.task`, `output`, `failureReason`, `progress`; `agent_memory.name`, `content`, `summary`; `agent_memory_version.content`; `events.data`; `workflow_run_steps.input`, `output`, `error`, `diagnostics`.
- It **redacts matching rows in place**. That is irreversible (a redaction, not a deletion). Take a copy first if forensic evidence matters.
- Regexes run outside the write lock. Each write is compare-and-set on the value read, so a concurrently updated row is skipped, not clobbered.
- `agent_memory` rows go through the memory store: FTS is rewritten, `contentHash` recomputed, and the embedding and `memory_vec` row dropped. The sweep then runs the re-embed backfill.
- A row whose scrub would turn valid JSON into invalid JSON is skipped and counted as `skipped_invalid_json`.
- Log line per table (counts only): `boot-scrub-v<N>: <table> scanned=… changed=… skipped_invalid_json=…`.
- To re-run a version by hand, delete its done row from `seed_state` and restart the API.
