# Kubernetes with Helm

Re-fetch the [chart README](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/README.md) and [values](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/values.yaml).
Confirm kubectl targets the intended cluster. The cluster needs a storage class that can provision persistent volumes.

Create an environment file named `swarm-secrets.env` with `API_KEY`, `SECRETS_ENCRYPTION_KEY`, and your selected harness credential.
Generate `API_KEY` with `openssl rand -hex 32`. Generate `SECRETS_ENCRYPTION_KEY` with `openssl rand -base64 32`.
Use a secret manager or protect this file with `chmod 600 swarm-secrets.env`. Preserve the encryption key with database backups.

```bash
kubectl create namespace agent-swarm
kubectl -n agent-swarm create secret generic agent-swarm-secrets \
  --from-env-file=swarm-secrets.env
helm show values oci://ghcr.io/desplega-ai/charts/agent-swarm > swarm-values.yaml
```

Review `swarm-values.yaml` before installation. Configure `pools`, resources, storage, URLs, and the selected harness.
The default pools use Claude. Use `poolDefaults.harnessProvider` or each pool's `harnessProvider` for another harness.
The chart permits one lead pool with one replica. Worker pools can have multiple replicas.
Each pod preserves its generated UUID on its personal PVC. Keep the API at one replica.

```bash
helm install swarm oci://ghcr.io/desplega-ai/charts/agent-swarm \
  --namespace agent-swarm \
  --set auth.existingSecret=agent-swarm-secrets \
  -f swarm-values.yaml
kubectl -n agent-swarm rollout status statefulset/swarm-agent-swarm-api
kubectl -n agent-swarm get pods,pvc
kubectl -n agent-swarm port-forward service/swarm-agent-swarm-api 3013:3013
```

Omit `--version` for latest. To pin a release, use the same `--version` for both `helm show values` and `helm install`.
The resource names above assume release `swarm` without a name override.
Keep port forwarding active while you execute the [API checks](https://github.com/desplega-ai/agent-swarm/blob/main/skills/agent-swarm/references/usage.md).

agent-fs, shared RWX storage, ingress, and Litestream are optional. Configure them through the [chart README](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/README.md).
