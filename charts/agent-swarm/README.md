# agent-swarm

[Helm](https://helm.sh) chart for [agent-swarm](https://github.com/desplega-ai/agent-swarm) — multi-agent orchestration for Claude Code, Codex, Gemini CLI, and other AI coding assistants.

## TL;DR

```bash
# 1. Create a Secret with at least API_KEY and your provider credential.
kubectl create secret generic agent-swarm-secrets \
  --from-literal=API_KEY=$(openssl rand -hex 32) \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN=<your-token>

# 2. Install.
helm install swarm oci://ghcr.io/desplega-ai/charts/agent-swarm \
  --version 0.1.0 \
  --set auth.existingSecret=agent-swarm-secrets
```

That's a minimal install: API + lead + 1 coder pool, no agent-fs, no litestream. Override `pools` in your own values to size the swarm.

## What this chart deploys

| Component | Always | Notes |
|---|---|---|
| API StatefulSet | yes | Single replica (SQLite single-writer). Chart fails to render if `api.replicas != 1`. |
| Pool StatefulSets | yes | One per entry in `.Values.pools`. Each pod persists its `AGENT_ID` to its personal PVC on first boot — scaling up just bumps `replicas`. |
| API Service | yes | ClusterIP by default. |
| Auth Secret | conditional | Created from `auth.*` inline values, or skipped when `auth.existingSecret` is set. |
| ServiceAccount | conditional | `serviceAccount.create: true` by default. |
| Ingress | opt-in | `ingress.enabled: true`. Standard `networking.k8s.io/v1` Ingress. |
| Litestream sidecar | opt-in | `litestream.enabled: true`. Streams the SQLite WAL to S3-compatible object storage. |
| agent-fs | opt-in | `agentFs.enabled: true`. Cross-agent searchable filesystem service. |
| RWX shared volume | opt-in | `sharedVolume.existingClaim`. Mount a pre-existing RWX PVC at `/workspace/shared` on every pool pod. |

## Identity model

Every pool pod (workers and the lead) uses `volumeClaimTemplates` for a per-pod PVC at `/workspace/personal`. On first boot, the pod's entrypoint:

1. Reads `/workspace/personal/.agent-id` if it exists → reuses that UUID
2. Otherwise mints a fresh UUID, writes it to the PVC, registers via `join-swarm`

This makes scaling boring: bump `replicas`, new pods come up with new identities. Scaling down leaves the PVC behind, so the agent can be re-introduced if you scale back up. Decommissioning an agent is a manual operation (delete the PVC + delete the agent record via the API).

## Pool roles

Pools are differentiated by the optional `role` field:

```yaml
pools:
  lead:
    replicas: 1
    role: lead          # Marks this pool as the swarm coordinator
    templateId: official/lead
  coder:
    replicas: 4
    # role omitted → defaults to "worker"
    templateId: official/coder
```

Constraints (enforced at `helm template` time):

- At most one pool may have `role: lead`
- The lead pool, if present, must have `replicas: 1`

The API also enforces single-lead at runtime via the `join-swarm` tool.

## Cross-agent shared filesystem

The swarm runs by default with **isolated agents** — each pod operates on its personal PVC and an in-pod `/workspace/shared` emptyDir. This is enough for many workflows: tasks, channels, messaging, scheduling, profiles, services, and tracker integrations are all API-DB-backed and work regardless.

Two opt-in patterns for cross-agent file sharing:

### Option 1 — agent-fs (recommended)

Deploys the [agent-fs](https://github.com/desplega-ai/agent-swarm/tree/main/agent-fs) HTTP service alongside the swarm. Provides full-text and semantic search, comments, threads, and conflict-aware writes. The upstream agents auto-detect the service and adapt their session prompts:

```yaml
agentFs:
  enabled: true
  bucket: my-agent-fs-bucket
  s3:
    existingSecret: my-agent-fs-s3-creds   # Or inline accessKeyId/secretAccessKey
    endpoint: https://s3.amazonaws.com     # Optional — for S3-compatible providers
    region: us-east-1                      # Optional
```

### Option 2 — RWX shared volume

If your cluster has a `ReadWriteMany`-capable storage class (NFS, EFS, Filestore, Azure Files, or any CSI driver advertising RWX), pre-create a PVC and point the chart at it:

```yaml
sharedVolume:
  existingClaim: my-rwx-pvc
```

Every pool pod mounts that claim at `/workspace/shared`. Simpler than agent-fs but lacks search, comments, and conflict primitives — and the upstream agents won't automatically know about the shared mount unless you configure them to.

## Authentication

Two paths:

### Inline (dev / quickstart only)

```yaml
auth:
  apiKey: super-secret
  claudeCodeOauthToken: sk-ant-oat...
  githubToken: ghp_...
```

The chart creates a Secret from these values. Don't check inline secrets into source control for production.

### existingSecret (recommended for production)

Pre-create a Secret with the keys you need (any combination of `API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `SECRETS_ENCRYPTION_KEY`):

```bash
kubectl create secret generic my-swarm-creds \
  --from-literal=API_KEY=... \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN=...
```

Then point the chart at it:

```yaml
auth:
  existingSecret: my-swarm-creds
```

Compatible with [External Secrets Operator](https://external-secrets.io), HashiCorp Vault, [SOPS](https://github.com/getsops/sops), [sealed-secrets](https://github.com/bitnami-labs/sealed-secrets), or any other secret-management tooling that produces a regular Kubernetes Secret.

## Backups (litestream)

`litestream.enabled: true` deploys a sidecar that streams the SQLite WAL to S3-compatible object storage:

```yaml
litestream:
  enabled: true
  bucket: my-swarm-backup
  endpoint: https://s3.amazonaws.com
  region: us-east-1
  s3:
    existingSecret: my-litestream-creds   # keys: LITESTREAM_ACCESS_KEY_ID, LITESTREAM_SECRET_ACCESS_KEY
```

Restore procedure: see the [litestream docs](https://litestream.io/guides/restore/).

## Configuration

See [`values.yaml`](./values.yaml) for the full configuration surface. Every field is documented inline.

## Development

```bash
helm lint .
helm template .
helm template . --set agentFs.enabled=true --set litestream.enabled=true
```

## License

MIT — see the [agent-swarm repository](https://github.com/desplega-ai/agent-swarm) for full license text.
