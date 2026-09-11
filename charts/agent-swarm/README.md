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
  --set auth.existingSecret=agent-swarm-secrets
```

Omit `--version` for latest, or pin the release you want.

That's a minimal install: API + lead + 1 coder pool, no agent-fs, no litestream. Override `pools` in your own values to size the swarm.

## What this chart deploys

| Component | Always | Notes |
|---|---|---|
| API StatefulSet | yes | Single replica (SQLite single-writer). Chart fails to render if `api.replicas != 1`. |
| Pool StatefulSets | yes | One per entry in `.Values.pools`. Each pod persists its `AGENT_ID` to its personal PVC on first boot — scaling up just bumps `replicas`. |
| API Service | yes | ClusterIP by default. |
| Auth Secret | conditional | Created from `auth.*` inline values, or skipped when `auth.existingSecret` is set. |
| ServiceAccount | conditional | `serviceAccount.create: true` by default. |
| Ingress | opt-in | API: `ingress.enabled: true`. Separate agent-fs ingress: `agentFs.enabled: true` and `agentFs.ingress.enabled: true`. Standard `networking.k8s.io/v1` Ingresses. See [ingress values, TLS, public URL, and CORS](../../DEPLOYMENT.md#api-ingress). |
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

Deploys the [agent-fs](https://github.com/desplega-ai/agent-fs) HTTP service alongside the swarm. Provides full-text and semantic search, comments, threads, and conflict-aware writes. When disabled, the swarm uses the built-in `local-fs` provider and files stay local to the API process.

```yaml
agentFs:
  enabled: true
  image:
    tag: 0.13.5
  bucket: my-agent-fs-bucket
  # Optional. When blank, the API boot seeder registers a service user with
  # agent-fs and stores the generated bootstrap key in encrypted swarm_config.
  apiKey: ""
  s3:
    existingSecret: my-agent-fs-s3-creds   # Or inline accessKeyId/secretAccessKey
    endpoint: https://s3.amazonaws.com     # Optional — for S3-compatible providers
    region: us-east-1                      # Optional
  embedding:
    provider: local                         # Or openai/gemini + apiKey
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

## Sandboxed-script pids containment

The API pod (not a pool pod — see "What this chart deploys") spawns a subprocess sandbox for every script/workflow run (`src/utils/sandboxed-process.ts`). That sandbox's own `ulimit -u` (`JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS`, 4096) is a per-real-UID limit shared by the API process itself *and* every concurrently running sandboxed script in that pod — it is headroom for an interpreter's own thread-pool startup, not independent containment against a runaway or malicious script exhausting that shared budget ([issue #1332](https://github.com/desplega-ai/agent-swarm/issues/1332)).

Kubernetes' native pod spec has no per-pod pids field — `resources.limits` only supports `cpu`/`memory`/`ephemeral-storage`. The [RuntimeClass API](https://kubernetes.io/docs/concepts/containers/runtime-class/) doesn't fill that gap either: a `RuntimeClass` object only selects a CRI runtime handler by name and optionally sets `overhead`/`scheduling` — it has no field for OCI PID resources, so pointing a pod at *any* RuntimeClass (an ordinary `runc` one included, and gVisor/Kata by default) applies no `pids.max` on its own. Two ways to add independent containment, neither of which this chart can fully own:

1. **Cluster-wide (works today, no chart change needed):** set the kubelet flag `--pod-max-pids` on the nodes that run the API pod (GA since Kubernetes 1.20, feature gate `SupportPodPidsLimit`). This caps every pod on that node, not just the API pod — coordinate with whoever owns your node pools/kubelet config, since it's out of this chart's control. This is the mechanism to reach for; it demonstrably works with no further provisioning.
2. **Per-pod, via `api.runtimeClassName`:** this field only wires the pod spec to reference a RuntimeClass by name — it does not, by itself, apply any pids ceiling. It's a containment mechanism only if the cluster administrator provisions a **specifically customized runtime handler that demonstrably injects `pids.max`** — e.g. a `runc` handler whose `config.toml` sets `[runtimes.<name>.options] SystemdCgroup` resources with a `pids.max`, or an equivalently configured gVisor/Kata handler — and confirms it (`cat /sys/fs/cgroup/.../pids.max` inside a pod using that handler). A stock/default handler under any of these runtimes gives you none of this:

   ```yaml
   api:
     runtimeClassName: swarm-api-pids-limited
   ```

   Empty (the default) sets no `runtimeClassName` — zero behavior change from before this field existed.

Docker Compose deployments get `pids_limit` directly on the `api` service — see the sizing arithmetic in `docker-compose.example.yml`'s `api.pids_limit` comment. That number was derived from process/thread measurements in a container, not validated against a live compose stack under real load; treat it as a documented starting point and tune it against your own traffic.

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
