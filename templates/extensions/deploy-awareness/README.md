# deploy-awareness

Appends one line to a new task's description while a Dokploy compose deploy is in progress, so the worker knows it may restart soon:

```
Note: a prod deploy started at 14:05 UTC is in progress; your worker may restart in the next few minutes. Checkpoint with store-progress before long steps.
```

Config:

```json
{
  "baseUrl": "https://dokploy.example.com",
  "composeId": "<compose id>",
  "apiKeySecret": "DOKPLOY_API_KEY",
  "label": "prod",
  "cacheTtlMs": 120000,
  "timeoutMs": 2000,
  "staleAfterMs": 1800000
}
```

- `baseUrl`, `composeId`, `apiKeySecret` are required. `apiKeySecret` is the NAME of a `swarm_config` secret, read with `config_get` at check time. The value is never written to config, state, logs, or a description.
- `label` is the environment word in the note. `cacheTtlMs` is how long a check result, a failure included, is reused. `timeoutMs` caps the Dokploy call.
- `staleAfterMs`: a deployment still `running` after this long is treated as a stuck record and ignored.

How it decides: it calls `GET /api/deployment.allByCompose?composeId=...`, takes the deployment with the newest `createdAt`, and counts a deploy as in progress when that deployment's `status` is `running`. Dokploy statuses are `running`, `done`, `error`, and `cancelled`.

Fail open: a missing secret, a Dokploy error, a bad response, or a timeout adds no line, and the task is created as usual. The handler never throws, so an outage cannot auto-disable the extension. A task whose description already carries the note (a resume or a follow-up) is left alone.

At most one Dokploy call runs per `cacheTtlMs` window. The cache lives in `ctx.state`, so API replicas share it, and tasks created at the same moment share one in-flight check.
