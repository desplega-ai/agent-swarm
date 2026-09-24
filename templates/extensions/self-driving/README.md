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

`classifier` is `rules`, `llm` or `jev` (default `rules`). `threshold` defaults to 3. `repos` maps a Sentry project to a swarm repo. `dispatch` must be `false`.

## Trigger

`POST /api/webhooks/<workflowId>` with a Sentry-shaped body. The webhook is unsigned, so anyone with the workflow id can post signals. Signals only write KV in namespace `ext-self-driving`.

## Run the demo

`skills/self-driving-guide/files/demo.sh` installs, enables, sends four curls (new error, repeat past threshold, noise, malformed), runs the sweep, then uninstalls and counts leftover assets:

```bash
MCP_BASE_URL=http://localhost:3013 API_KEY=123123 bash templates/extensions/self-driving/skills/self-driving-guide/files/demo.sh
```

The API server must have `MCP_BASE_URL` pointing at itself, because workflow scripts call back to it.
