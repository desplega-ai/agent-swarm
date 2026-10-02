# deploy-awareness

Appends one line to a new task's description while a Dokploy compose deploy is in progress, so the worker knows it may restart soon:

```
Note: a prod deploy started at 14:05 UTC is in progress; your worker may restart in the next few minutes. Checkpoint with store-progress before long steps.
```

Install config:

```json
{ "composeId": "<compose id>" }
```

Optional keys: `label` (the environment word in the note, default `prod`), `cacheTtlMs` (how long a check result, a failure included, is reused, default 120000), `timeoutMs` (caps the Dokploy call, default 2000), `staleAfterMs` (a deployment still `running` after this long is a stuck record and is ignored, default 1800000).

The Dokploy API key and URL are not extension config. Config is writable by a lead, and a key name or a host there would let it point the API process at any env secret and any host. They come from the API process environment:

- `DOKPLOY_API_KEY`: required. A global `swarm_config` secret. The API process loads global rows into `process.env` at boot and on config reload. `ctx.swarm.config_get` cannot serve this, because the SDK scrubs every response and a secret comes back as `[REDACTED:<name>]`.
- `DOKPLOY_BASE_URL`: optional, default `https://app.dokploy.com`. It must be an `https` URL. Anything else, including an unparseable value, sends no request and logs a warning that names the variable and not its value.

The key is never written to config, state, logs, or a description.

How it decides: it calls `GET /api/deployment.allByCompose?composeId=...`, takes the deployment with the newest `createdAt`, and counts a deploy as in progress when that deployment's `status` is `running`. Dokploy statuses are `running`, `done`, `error`, and `cancelled`.

Fail open: a missing key, a non-https `DOKPLOY_BASE_URL`, a Dokploy error, a bad response, or a timeout adds no line, and the task is created as usual. The handler never throws, so an outage cannot auto-disable the extension. A task whose description already carries the note (a resume or a follow-up) is left alone.

At most one Dokploy call runs per `cacheTtlMs` window. The cache lives in `ctx.state`, so API replicas share it, and tasks created at the same moment share one in-flight check.
