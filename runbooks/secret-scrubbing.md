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

Secret `swarm_config` writes also register the new plaintext with the scrubber synchronously before the write call returns. This closes the in-process window between rotating a secret and persisting task output or rendering an automatic Slack completion that contains it. Callers adding another runtime secret source must likewise call `registerVolatileSecret(value, name)` at the successful write/rotation boundary.

Volatile registration is process-local. It does not update another already-running API or worker process. Cross-process coverage begins only after that process reloads the config or otherwise learns and registers the new value; deployments with multiple API replicas must coordinate reloads when rotating shared secrets.

## Coverage

The scrubber is worker/API-neutral: it reads `process.env` and its process-local volatile registry, but never accesses the database. It is safe to import from either side without violating the DB boundary.

It covers:

- **Env-sourced values:** any env value ≥12 chars exact-match, plus comma-separated pool components.
- **Runtime config values:** successful secret `swarm_config` writes register values ≥12 chars for immediate, process-local exact-match scrubbing.
- **Structural patterns:** GitHub PATs, Anthropic/OpenAI/OpenRouter `sk-*`, Slack `xox*`, JWTs, AWS access keys, Google API keys.

## Adding a new secret shape

1. Extend `SENSITIVE_KEY_EXACT` (env-key match) or `TOKEN_REGEXES` (structural pattern) in `src/utils/secret-scrubber.ts`.
2. Add a regression test in `src/tests/secret-scrubber.test.ts`.
