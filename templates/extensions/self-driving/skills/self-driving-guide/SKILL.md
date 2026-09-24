---
name: self-driving-guide
description: Install, enable and exercise the self-driving MVP extension with mocked Sentry payloads. Use when someone asks to test the self-driving loop or send it a fake Sentry error.
---

# Self-driving MVP

The `self-driving` extension runs one loop per signal: ingest, classify, cluster, propose. It is a dry run in every mode. It never creates a task, opens a PR, or posts to Slack.

## Install and enable

```bash
curl -sX POST "$MCP_BASE_URL/api/extensions/install" -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"template":"self-driving","config":{"classifier":"rules","threshold":3,"repos":[{"project":"demo-shop-web","repo":"desplega-ai/sds-demo-shop"}],"dispatch":false}}'
curl -sX POST "$MCP_BASE_URL/api/extensions/<id>/enable" -H "Authorization: Bearer $API_KEY"
```

Or use the `extension-install` and `extension-enable` tools. Enable turns on the workflow, the schedule and this skill.

## Send a signal

Find the workflow id with `list-workflows` (name `self-driving-signal`), then post a signed Sentry-shaped body to its webhook. The webhook needs no API key, but it needs an HMAC-SHA256 signature keyed with the global secret `SELF_DRIVING_WEBHOOK_SECRET`. Set it once (the manifest cannot declare it):

```bash
SECRET=$(openssl rand -hex 32)
curl -sX PUT "$MCP_BASE_URL/api/config" -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "{\"scope\":\"global\",\"key\":\"SELF_DRIVING_WEBHOOK_SECRET\",\"value\":\"$SECRET\",\"isSecret\":true}"
```

Then sign the exact raw body:

```bash
BODY='{"project":"demo-shop-web","event":{"event_id":"e1","title":"TypeError: cart is undefined","level":"error","culprit":"checkout/submit","fingerprint":["cart-undefined"]}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)
curl -sX POST "$MCP_BASE_URL/api/webhooks/<workflowId>" -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=$SIG" --data-binary "$BODY"
```

A missing or wrong signature gets 401. Ingest rejects payloads over 16 KB or with oversized fields, and skips a repeat of the same event inside `cooldownSeconds` (default 300).

The response is `{ "runId": ... }`. Read the result with `get-workflow-run`: the `propose` step holds the dry-run action.

`templates/extensions/self-driving/skills/self-driving-guide/files/demo.sh` in the agent-swarm repo (bundled with this skill as `demo.sh`) runs the four test cases end to end.

## Read the state

Clusters live in swarm KV, namespace `ext-self-driving`, keys `cluster:<id>`, `proposal:<id>` and `dedupe:<sha256>`. Use `kv-list` with that namespace.

## Config

| Key | Default | Meaning |
|---|---|---|
| `classifier` | `rules` | `llm` and `jev` are accepted and return "not implemented in the MVP" |
| `threshold` | `3` | Signals in a cluster before it proposes an action |
| `repos` | `[]` | `{ project, repo }` pairs mapping a Sentry project to a swarm repo |
| `dispatch` | `false` | Must be `false`. The MVP cannot dispatch. |
| `cooldownSeconds` | `300` | Skip a repeat of the same event on the same fingerprint inside this window. `0` turns it off. |
