# Component minimums

Re-fetch the linked files from `main`. These three tiers describe configuration location, not hardware sizing.
**A: boot environment** contains credentials, identity, and inputs that the process needs before configuration loads.
**B: stored configuration** contains supported values in swarm config. Prefer Settings → Configuration, Settings → Secrets, or `PUT /api/config`.
**C: optional** contains capabilities you can omit. A dash in a table means no additional requirement.

Keep `.env` minimal. Do not copy every setting into every container.
The API and each worker have separate environments. A credential supplied only to a worker does not configure API embeddings.

## Resolution and secrets

Global configuration enters the API environment at boot. Existing nonempty deployment values win at boot. Stored values win after reload.
Global saves automatically schedule a reload. `POST /api/config/reload` also resets supported integrations.
Mark credentials with `isSecret: true`. The API encrypts them with its encryption key.
The guard reserves `API_KEY` and `SECRETS_ENCRYPTION_KEY`. Supply them through deployment secrets, not swarm config.
Use `AGENT_SWARM_API_KEY` as the preferred environment alias when supported. Keep API authentication outside stored configuration.
Read the [configuration loader](https://github.com/desplega-ai/agent-swarm/blob/main/src/http/core.ts), [config endpoint](https://github.com/desplega-ai/agent-swarm/blob/main/src/http/config.ts), and [reserved-key guard](https://github.com/desplega-ai/agent-swarm/blob/main/src/be/swarm-config-guard.ts).

Workers fetch global and agent configuration for each task. Stored values override their container environment for that task.
This does not guarantee that every process-level setting reloads. Preserve boot credentials and identity in deployment configuration.
Read the [worker runner](https://github.com/desplega-ai/agent-swarm/blob/main/src/commands/runner.ts).

Example of a nonsecret global setting, with `API_KEY` and `MCP_BASE_URL` already exported:

```bash
curl -fsS -X PUT "$MCP_BASE_URL/api/config" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"scope":"global","key":"MEMORY_RATERS","value":"llm"}'
```

Use the [Slack procedure](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/slack.md) for secret writes.

## API, workers, and storage

| Component and reason | A: boot environment or deployment minimum | B: prefer swarm config | C: optional |
|---|---|---|---|
| API: authenticate clients and preserve encrypted secrets. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/docker-compose.example.yml) | Set `API_KEY` in the examples. Compose requires the `encryption_key` file through `SECRETS_ENCRYPTION_KEY_FILE`. Helm can use `SECRETS_ENCRYPTION_KEY` in its Secret. | Catalog flags, limits, branding, and supported integration settings. | `PORT` defaults to 3013. A fresh API without an explicit encryption key can generate one in its data directory. Preserve that actual key. |
| API URLs: make callbacks and browser links reach the right service. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/templates/configmap.yaml) | Supply worker `MCP_BASE_URL` at boot. Set API `MCP_BASE_URL` and `APP_URL` for your deployment. These URLs have defaults and are not reserved secrets. | Supported public URLs and branding after boot. | `PUBLIC_MCP_BASE_URL` for a public API behind an internal service URL. `SWARM_URL` for service discovery. |
| API volume: preserve SQLite and recovery state. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/docker-compose.example.yml) | Compose `swarm_api:/app`. Helm API PVC with one API replica and writable storage. | No configuration row replaces storage. | Litestream backups. Preserve the database and its actual encryption key together. |
| Agent services: preserve registration and task recovery. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/docker-compose.example.yml) | Per service: API key, API URL, stable UUID `AGENT_ID`, role, harness credential, and a personal volume. Use `AGENT_ROLE=lead` once. Set `TEMPLATE_ID` to select the initial profile. | Agent profiles, skills, MCP servers, model tiers, and supported harness settings. | Additional services and templates. `TEMPLATE_ID` is optional in runtime but explicit in the examples. |
| Worker volumes: retain personal files and share local work. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/README.md) | Compose uses `swarm_logs:/logs`, `swarm_shared:/workspace/shared`, and a distinct `swarm_<agent>:/workspace/personal`. Helm assigns a personal PVC per pool pod. | No configuration row replaces a volume. | Helm uses temporary logs and shared directories by default. A shared RWX claim is optional. Pool `replicas` control worker count. |

Use [Settings → Configuration](https://docs.agent-swarm.dev/docs/ui/configuration) for catalog values.
Respect `restartRequired`, especially heartbeat settings and worker readiness timeouts.

## Harness credentials

Set only the credential set for the selected harness. Credentials authenticate model calls.
Read the [environment example](https://github.com/desplega-ai/agent-swarm/blob/main/.env.docker.example) and [harness guide](https://docs.agent-swarm.dev/docs/guides/harness-configuration).

| Harness | A: boot minimum | B: prefer swarm config | C: optional |
|---|---|---|---|
| Claude | `HARNESS_PROVIDER=claude`, plus `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. | Agent profile, capacity, and portable model tier. | `MODEL_OVERRIDE`. OAuth token creation: `claude setup-token`. |
| Codex | `HARNESS_PROVIDER=codex` and `OPENAI_API_KEY` for the direct-key path. | Agent profile, capacity, and portable model tier. | OAuth setup through the integration UI. Preserve its credential storage. |
| OpenRouter | `HARNESS_PROVIDER=pi`, `OPENROUTER_API_KEY`, and `MODEL_OVERRIDE` for the selected model. | Agent profile and portable model tier. | `OPENROUTER_BASE_URL` for a compatible gateway. |
| Bedrock | `HARNESS_PROVIDER=pi`, `BEDROCK_AUTH_MODE=sdk`, `AWS_REGION`, and `MODEL_OVERRIDE=amazon-bedrock/<model-id>`. Supply AWS credentials or a mounted AWS profile. | Agent profile and supported capacity settings. | `AWS_SESSION_TOKEN` for temporary credentials. `AWS_PROFILE` requires the matching profile mount. Bedrock support is alpha. |

For multiple agents, each service needs its own identity and personal volume. Helm creates those identities from each pool pod's PVC.
Keep initial harness selection and credentials available before the worker can fetch configuration.
Stored harness changes do not replace the credential requirements of the selected provider.

## Embeddings and memory rating

| Component and reason | A: boot minimum | B: prefer swarm config | C: optional |
|---|---|---|---|
| API embeddings: enable semantic memory search. [Provider](https://github.com/desplega-ai/agent-swarm/blob/main/src/be/memory/providers/openai-embedding.ts) | None to boot. Without a usable key, search falls back to full-text search and fallback ranking. | `EMBEDDING_API_KEY` as a secret, or `OPENAI_API_KEY`. Set `EMBEDDING_MODEL` and optional `EMBEDDING_API_BASE_URL`. Restart the API after changes. | Defaults to OpenAI-compatible `text-embedding-3-small`. A compatible endpoint must support the requested dimensions. |
| Session summaries and memory rating: preserve context and score retrieved memories. [Credential resolver](https://github.com/desplega-ai/agent-swarm/blob/main/src/utils/internal-ai/credentials.ts) | No extra key to boot. The runtime can reuse supported harness credentials. Bedrock credentials alone do not resolve here. | `MEMORY_RATERS=llm` opts into rating. Unset or empty selects no rating. Store additional provider keys as secrets when needed. | Production model override is `MEMORY_RATER_MODEL`. See the limitations below. |

Embedding key precedence is `EMBEDDING_API_KEY`, then `OPENAI_API_KEY`. An explicitly empty `EMBEDDING_API_KEY` blocks that fallback.
`OPENROUTER_API_KEY` alone does not configure embeddings. The provider retains its key and model after construction, so configuration reload does not refresh them.
Read the [memory initialization](https://github.com/desplega-ai/agent-swarm/blob/main/src/be/memory/index.ts) and [search fallback](https://github.com/desplega-ai/agent-swarm/blob/main/src/be/memory/providers/sqlite-store.ts).

Production summary credentials resolve in this order: OpenRouter, Anthropic API key, OpenAI API key, Codex OAuth, then Claude OAuth through the CLI.
Without a supported credential, summaries and their rating step do not run.
The catalog's `MEMORY_LLM_RATER_MODEL` controls a legacy direct Claude client. It does not control the production summary path.
`MEMORY_RATER_MODEL` currently reads the worker process environment. Treat that override as a worker deployment setting and restart workers after changing it.
This override applies to the shared internal-ai path. The opencode plugin uses its own fixed summary model.
Read the [model resolver](https://github.com/desplega-ai/agent-swarm/blob/main/src/utils/internal-ai/models.ts) and [rater registry](https://github.com/desplega-ai/agent-swarm/blob/main/src/be/memory/raters/registry.ts).

## agent-fs

agent-fs provides shared files and searchable artifacts. It is optional.
Read [co-deployment](https://docs.agent-swarm.dev/docs/guides/agent-fs-co-deployment) and the [provisioner](https://github.com/desplega-ai/agent-swarm/blob/main/src/be/seed/agent-fs-provision.ts).

| A: boot or service minimum | B: prefer swarm config | C: optional |
|---|---|---|
| No agent-fs values are required when omitted. For co-deployment, provide reachable `AGENT_FS_API_URL`, agent-fs storage, and its S3 credentials. | Provisioning creates encrypted `API_AGENT_FS_API_KEY`, default org and drive IDs, and separate agent-scoped keys. Workers receive their own keys. | Supply `API_AGENT_FS_API_KEY` only for an existing bootstrap identity. `AGENT_FS_REGISTER_EMAIL` has a generated default. Local agent-fs embeddings need no hosted API key. |

The URL alone enables automatic API provisioning. The active provider then requires the generated key, organization, and drive.
Never distribute the API bootstrap key to workers. Provisioning reads a stored bootstrap key before an environment key.
The URL and registration email prefer environment values before stored values during provisioning.
Configuration reload resets filesystem provider selection. It can activate a provisioned service without restarting the API.

To omit agent-fs from Compose, remove `minio`, `minio-init`, and `agent-fs` services.
Remove the API's agent-fs dependency and its `AGENT_FS_*` and `API_AGENT_FS_API_KEY` entries.
Remove `AGENT_FS_API_URL` from every worker. Remove unused agent-fs volume declarations.
With no endpoint, the API uses local-fs. Helm already defaults to `agentFs.enabled=false`.

Back up Compose volumes `agent_fs_data` and `agent_fs_minio`. For Helm, back up the agent-fs PVC and its S3 bucket.
These stores complement the swarm database and encryption key backups.

## Integrations and connections

These integrations are optional. Configure only the systems you use.
For the reloadable API integrations below, tier A has no extra secret requirement. Tier B holds their functional minimums.
Stored configuration follows the API precedence described above unless a row states otherwise.

| Component and reason | A: boot requirement | B: preferred stored minimum | C: optional |
|---|---|---|---|
| Slack: native work intake and replies. [Guide](https://docs.agent-swarm.dev/docs/integrations/slack) | None beyond the API. | Global secrets `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`. Set `SLACK_DISABLE=false`. Reload reconnects Socket Mode. | Thread steering and access filters. No signing secret is needed for current Socket Mode. |
| GitHub: repository webhooks. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/src/github/app.ts) | Public webhook URL for inbound events. | `GITHUB_WEBHOOK_SECRET`. App reactions additionally need `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. | Worker `GITHUB_TOKEN` for gh and git operations. `GITHUB_DISABLE` controls ingestion. |
| GitLab: repository webhooks and API actions. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/src/gitlab/auth.ts) | Public webhook URL. | `GITLAB_WEBHOOK_SECRET` for inbound events, `GITLAB_TOKEN` for API actions. | `GITLAB_URL` for self-managed GitLab. `GITLAB_DISABLE` controls ingestion. |
| Linear: issue tasks and replies. [Guide](https://docs.agent-swarm.dev/docs/integrations/linear) | Reachable OAuth and webhook URLs. | `LINEAR_CLIENT_ID`, secret `LINEAR_CLIENT_SECRET`, and `LINEAR_SIGNING_SECRET`. Complete OAuth in the browser. | `LINEAR_DISABLE` and workspace settings. |
| Jira: issue tasks and replies. [Guide](https://docs.agent-swarm.dev/docs/integrations/jira) | Reachable OAuth and webhook URLs. | `JIRA_CLIENT_ID`, secret `JIRA_CLIENT_SECRET`, and `JIRA_WEBHOOK_TOKEN`. Complete OAuth and webhook registration. | `JIRA_DISABLE` and site settings. |
| AgentMail: email intake and sending. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/src/agentmail/app.ts) | Public webhook URL for intake. | `AGENTMAIL_WEBHOOK_SECRET` for receipt. `AGENTMAIL_API_KEY` for outbound automation. | Inbox mappings and `AGENTMAIL_DISABLE`. |
| Kapso: WhatsApp messages. [Source](https://github.com/desplega-ai/agent-swarm/blob/main/src/integrations/kapso/config.ts) | Public webhook URL for intake. | `KAPSO_API_KEY`, `KAPSO_PHONE_NUMBER_ID` for outbound, and `KAPSO_WEBHOOK_HMAC_SECRET` for verified inbound. | Routing settings. Each call reads global config before env, without reload. |
| Sentry: inspect errors from workers. [Guide](https://docs.agent-swarm.dev/docs/integrations/sentry) | None beyond the worker. | Secret `SENTRY_AUTH_TOKEN` plus `SENTRY_ORG` in global or agent config. Workers receive changes on their next task. | Project selection. There is no persistent API integration to restart. |
| Connections: extend scripts with external services. [Guide](https://docs.agent-swarm.dev/docs/guides/script-connections) | None beyond the API. | Settings → Connections defines OpenAPI, GraphQL, or MCP endpoints and authentication. | Composio through the `x` router. Provider credentials depend on the chosen connection. |
