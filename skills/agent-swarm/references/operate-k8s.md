# Operate agent-swarm on Kubernetes

Day-2 procedures for a chart release named `swarm` in namespace `agent-swarm`. Adjust names when you used a different release or `fullnameOverride`.
Re-fetch the [chart README](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/README.md) and [values](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/values.yaml) before acting.

## Resource map

| Resource | Name | Notes |
|---|---|---|
| API | `statefulset/swarm-agent-swarm-api`, `service/swarm-agent-swarm-api` | One replica. SQLite on PVC `api-data-swarm-agent-swarm-api-0`. |
| Pools | `statefulset/swarm-agent-swarm-<pool>` | One per `pools.<name>`. Label `agent-swarm.dev/pool=<name>`. |
| Pool identity | PVC `personal-swarm-agent-swarm-<pool>-<ordinal>` | Holds `.agent-id`. Deleting it creates a new agent. |
| Config | `configmap/swarm-agent-swarm-config` | Non-secret env. |
| Credentials | `secret/swarm-agent-swarm-auth` or `auth.existingSecret` | `API_KEY`, harness keys, `SECRETS_ENCRYPTION_KEY`. |
| agent-fs | `deployment/swarm-agent-swarm-agent-fs`, PVC `swarm-agent-swarm-agent-fs` | Present when `agentFs.enabled`. |
| Ingress | `ingress/swarm-agent-swarm`, `ingress/swarm-agent-swarm-agent-fs` | TLS Secrets `swarm-agent-swarm-api-tls`, `-agent-fs-tls` with cert-manager. |

## Health

```bash
kubectl -n agent-swarm get pods,pvc,ingress,certificate
kubectl -n agent-swarm logs statefulset/swarm-agent-swarm-api --tail=100
curl -fsS https://swarm-api.example.com/health
curl -fsS -H "Authorization: Bearer $API_KEY" https://swarm-api.example.com/api/agents | jq '.agents[] | {name, status, isLead}'
```

Pool pods have no HTTP listener. Their probes run `pgrep -f agent-swarm`. Read pool logs with `kubectl -n agent-swarm logs swarm-agent-swarm-coder-0`.
Confirm `PUBLIC_MCP_BASE_URL` in the ConfigMap is the `https://` origin browsers use. Read the [HTTPS procedure](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/https.md).

## Upgrade

```bash
helm repo update
helm upgrade swarm oci://ghcr.io/desplega-ai/charts/agent-swarm \
  --namespace agent-swarm --version <new> -f swarm-values.yaml
kubectl -n agent-swarm rollout status statefulset/swarm-agent-swarm-api
kubectl -n agent-swarm rollout status statefulset/swarm-agent-swarm-coder
```

The API applies SQL migrations at boot. Migrations are forward-only; take a backup before an upgrade (see Backups). The image tag follows the chart `appVersion` unless `image.tag` or `workerImage.tag` is set.
Pool pods roll `poolDefaults.updateStrategy.maxUnavailable` at a time (default 50%). A pod that is mid-task pauses the task on SIGTERM and any worker resumes it after the roll, within `poolDefaults.terminationGracePeriodSeconds`.
Roll back with `helm rollback swarm <revision>`. A rollback does not undo migrations; restore the database from backup when the schema moved.

## Scale workers

Set `pools.<name>.replicas` and run `helm upgrade`. Each new ordinal mints its own UUID on first boot and registers itself.

```bash
helm upgrade swarm oci://ghcr.io/desplega-ai/charts/agent-swarm -n agent-swarm \
  --reuse-values --set pools.coder.replicas=4
```

Scaling down leaves the PVCs of removed ordinals in place. Scaling back up reuses them, so the same agents return. Delete a PVC only to retire an agent permanently. The API keeps the agent row; remove it from the dashboard or the API when it should stop appearing.
Add a pool by adding a `pools.<name>` entry with a `templateId`. Keep exactly one pool with `role: lead` and `replicas: 1`.

## Rotate credentials

Inline `auth.*` values: change them in values and `helm upgrade`. The chart stamps a checksum annotation, so pods restart.
`auth.existingSecret`: update the Secret, then restart consumers, since envFrom does not reload:

```bash
kubectl -n agent-swarm rollout restart statefulset -l app.kubernetes.io/name=agent-swarm
```

Never change `SECRETS_ENCRYPTION_KEY`. Every encrypted swarm-config value (integration tokens, agent-fs keys) becomes unreadable. Read [secrets encryption](https://docs.agent-swarm.dev/docs/guides/secrets-encryption).

## Backups and restore

Litestream streams the SQLite WAL to S3 when `litestream.enabled` is set. Configure it in the [chart README](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/README.md). Restoration follows the [Litestream guide](https://litestream.io/guides/restore/).
Without Litestream, snapshot the API PVC with your storage class, or copy the file while the API is stopped:

```bash
kubectl -n agent-swarm scale statefulset/swarm-agent-swarm-api --replicas=0
kubectl -n agent-swarm run backup --rm -it --image=busybox --restart=Never \
  --overrides='{"spec":{"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"api-data-swarm-agent-swarm-api-0"}}],"containers":[{"name":"backup","image":"busybox","command":["sleep","3600"],"volumeMounts":[{"name":"d","mountPath":"/data"}]}]}}' &
kubectl -n agent-swarm cp backup:/data/agent-swarm-db.sqlite ./agent-swarm-db.sqlite   # DATABASE_PATH is /app/data/agent-swarm-db.sqlite in the API pod
kubectl -n agent-swarm delete pod backup
kubectl -n agent-swarm scale statefulset/swarm-agent-swarm-api --replicas=1
```

Back up the encryption key together with the database. One without the other is useless.
With `agentFs.storageProvider: local`, the agent-fs PVC holds every stored object. Snapshot it as well.

## Troubleshoot

| Symptom | Check | Fix |
|---|---|---|
| API pod `Pending` | `kubectl describe pvc api-data-swarm-agent-swarm-api-0` | No default StorageClass, or the class cannot bind. Set `api.storage.storageClassName`. |
| Pool pod `Init:0/1` | `kubectl logs <pod> -c wait-for-api` | API not ready. Fix the API first. |
| Pool logs `credential-wait` | Secret has no harness credential | Add `CLAUDE_CODE_OAUTH_TOKEN` (or the provider's key) to the Secret and restart. |
| Ingress returns 502 or LB targets unhealthy | Probe path | Load balancers must probe `/health`; `/` returns 401. See the chart README "Load balancer health checks". |
| Dashboard shows mixed-content or CORS error | `PUBLIC_MCP_BASE_URL` and `CORS_ALLOWED_ORIGINS` | Public URL must be `https://`. Self-hosted UI origins go in `CORS_ALLOWED_ORIGINS` via `config.extraEnv`. Read the [Kubernetes guide](https://docs.agent-swarm.dev/docs/guides/kubernetes). |
| `certificate` stays `READY=False` | `kubectl describe certificate`, `kubectl get challenge -A` | HTTP-01 needs port 80 reachable at the host, DNS pointing at the ingress, and a matching `ingressClassName` in the issuer. |
| agent-fs stays `local-fs` | `curl -H "Authorization: Bearer $API_KEY" https://<api>/api/fs/capabilities` | agent-fs pod not ready at API boot. Provisioning is lazy; retry, or `POST /api/config/reload`. |
| Pods cannot reach Services or DNS on a node that also runs Docker or Tailscale (k3s) | `iptables -S FORWARD` shows `DOCKER-FORWARD` or `ts-forward` before `FLANNEL-FWD` with policy `DROP` | Move the CNI accept rule first: `iptables -I FORWARD 1 -j FLANNEL-FWD` (persist it in your firewall tooling), or run the cluster on a node without Docker. |
| Two agents with the same name after a PVC loss | `.agent-id` gone | Identity lives on the personal PVC. Restore it or accept a new agent and retire the old row. |

Port-forward when the ingress is down:

```bash
kubectl -n agent-swarm port-forward service/swarm-agent-swarm-api 3013:3013
curl -fsS http://localhost:3013/health
```

## Uninstall

```bash
helm uninstall swarm -n agent-swarm
kubectl -n agent-swarm get pvc --show-labels                              # confirm every claim you expect is listed
kubectl -n agent-swarm delete pvc -l app.kubernetes.io/name=agent-swarm   # destroys the database, agent identities, and local agent-fs objects
```

The label selector matches all three kinds of claim. The standalone agent-fs PVC carries the chart labels directly, and the StatefulSet controller copies its selector labels (`app.kubernetes.io/name`, `app.kubernetes.io/instance`) onto every PVC it creates from `volumeClaimTemplates`, so the API `api-data-*` and pool `personal-*` claims match too. If the `get pvc` listing shows a claim without that label, delete it by name.
Helm does not delete PVCs. Keep them to reinstall with the same data and agents.
