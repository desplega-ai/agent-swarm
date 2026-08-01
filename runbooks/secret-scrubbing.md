# Secret scrubbing runbook

Centralized scrubber for any path that emits to logs, stdout/stderr, terminal `task.output`, the `session_logs` table, or `/workspace/logs/*.jsonl`.

## Rule

Never print raw env values, credential-pool entries, OAuth payloads, webhook bodies, or tool output that may embed tokens. Wrap output through `scrubSecrets` at the **egress** point, not the source.

```ts
import { scrubSecrets } from "./utils/secret-scrubber";
console.log(scrubSecrets(maybeContainsToken));
```

Module: `src/utils/secret-scrubber.ts`.

## Cache refresh

After reloading `swarm_config` or rotating credential pools, call `refreshSecretScrubberCache()` so newly-added secrets get covered. `/internal/reload-config` and worker credential-selection already do this.

## Coverage

The scrubber is worker/API-neutral (reads only `process.env`) — safe to import from either side without violating the DB boundary.

It covers:

- **Env-sourced values:** any env value ≥12 chars exact-match, plus comma-separated pool components.
- **Structural patterns:** GitHub PATs, Anthropic/OpenAI/OpenRouter `sk-*`, Slack `xox*`, JWTs, AWS access keys, Google API keys.
- **Runner-buffered terminal output:** the last-assistant-text fallback is scrubbed before its 30,000-character cap and before the task finish request.

## Adding a new secret shape

1. Extend `SENSITIVE_KEY_EXACT` (env-key match) or `TOKEN_REGEXES` (structural pattern) in `src/utils/secret-scrubber.ts`.
2. Add a regression test in `src/tests/secret-scrubber.test.ts`.
