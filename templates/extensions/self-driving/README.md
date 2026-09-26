# self-driving

MVP of the self-driving loop from the self-driving swarm proposal. It exists to test the extension interface with mocked Sentry payloads, not to ship the product.

It is a dry run in every mode. No asset creates a task, opens a PR, or posts to Slack.

| Asset | Name | What it does |
|---|---|---|
| Script | `self-driving-ingest` | Normalizes a Sentry-shaped payload into a signal: source, project, repo, fingerprint, title, level |
| Script | `self-driving-classify` | Rules classifier that emits the proposal's default classification schema (§3.2). `llm` and `jev` return "not implemented in the MVP". |
| Script | `self-driving-cluster` | Groups signals by fingerprint in swarm KV and flags clusters at `threshold`. `mode: sweep` lists clusters past threshold with no proposal yet. |
| Script | `self-driving-propose` | Returns the task the loop would create (title, repo, cluster id, route) and records it in KV |
| Schedule | `self-driving-sweep` | Runs the cluster script with `mode: sweep` every 10 minutes while the extension is enabled |
| Workflow | `self-driving-signal` | Webhook trigger with a `triggerSchema`. Runs ingest, classify, cluster, propose. |
| Skill | `self-driving-guide` | How to install, enable and curl it. Bundles `demo.sh`. |
| Hooks | `hooks.ts` | No events. Exports the config schema. |

## Config

```json
{
  "classifier": "rules",
  "threshold": 3,
  "repos": [{ "project": "demo-shop-web", "repo": "desplega-ai/sds-demo-shop" }],
  "dispatch": false
}
```

`classifier` is `rules`, `llm` or `jev` (default `rules`). `threshold` defaults to 3. `repos` maps a Sentry project to a swarm repo. `dispatch` must be `false`. `cooldownSeconds` (default 300, 0 turns it off) is the dedupe window below.

## Trigger

`POST /api/webhooks/<workflowId>` with a Sentry-shaped body, signed. Signals only write KV in namespace `ext-self-driving`.

### Set the webhook secret

The trigger declares `hmacSecret: secret.SELF_DRIVING_WEBHOOK_SECRET`. The manifest cannot declare or create a secret, and install does not surface a missing one, so the operator sets it before sending signals:

```bash
curl -sX PUT "$MCP_BASE_URL/api/config" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"scope\":\"global\",\"key\":\"SELF_DRIVING_WEBHOOK_SECRET\",\"value\":\"$(openssl rand -hex 32)\",\"isSecret\":true}"
```

Without it, every webhook call fails closed (500, secret not found). A call with a missing or wrong signature gets 401.

### Sign a request

Send `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of the exact raw body:

```bash
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -sX POST "$MCP_BASE_URL/api/webhooks/<workflowId>" -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=$SIG" --data-binary "$BODY"
```

### Limits and cooldown

`self-driving-ingest` rejects a payload before any write when it is over 16 KB, `project` is over 200 chars, `event.title` or `culprit` over 500, `event_id` over 128, or `fingerprint` has more than 20 items or an item over 200 chars. The `triggerSchema` cannot enforce these: its validator ignores `maxLength` and `maxItems`.

The same event (`event_id`, or title when absent) on the same fingerprint inside `cooldownSeconds` is skipped at ingest, so classify, cluster and propose write nothing. The key is `dedupe:<sha256>` in `ext-self-driving`, with a KV TTL. Distinct events on one fingerprint still count toward `threshold`.

There is no server-side body cap or rate limit on `/api/webhooks/{workflowId}`. The signature is the gate against unauthenticated floods; a signed sender can still start runs as fast as it posts.

## Run the demo

`skills/self-driving-guide/files/demo.sh` installs, enables, sets a random webhook secret, sends signed curls (new error, repeat past threshold, noise, malformed, unsigned, oversized, replay inside the cooldown), runs the sweep, then uninstalls and counts leftover assets:

```bash
MCP_BASE_URL=http://localhost:3013 API_KEY=123123 bash templates/extensions/self-driving/skills/self-driving-guide/files/demo.sh
```

The API server must have `MCP_BASE_URL` pointing at itself, because workflow scripts call back to it.
