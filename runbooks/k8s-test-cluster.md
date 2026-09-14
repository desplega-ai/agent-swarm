# Runbook: test the Helm chart on a throwaway Kubernetes cluster

How to stand up a single-node k3s cluster on a Linux VPS, install the chart with real HTTPS, verify it end to end, and tear everything down. This is the procedure used to validate the cert-manager shortcut, agent-fs local storage, and the example values in `charts/agent-swarm/examples/`.

Budget: about 20 minutes, most of it image pulls. You need a VPS you can SSH into with sudo, a domain whose DNS you control, and a Claude (or other harness) credential for one smoke task.

## 0. Pick the host carefully

k3s wants ports 80 and 443 for its ingress and it installs its own iptables rules. Two things bite on a shared VPS:

- **A reverse proxy already owns 80/443** (Caddy, nginx, Dokploy's Traefik). Install k3s with `--disable traefik --disable servicelb`, run ingress-nginx as a NodePort, and let the host proxy forward to it. That is the layout below.
- **Another product manages the firewall.** Docker adds `DOCKER-FORWARD`, Tailscale adds `ts-forward`, and any nftables table with a `forward` chain and `policy drop` blocks pod-to-pod traffic even when the iptables `FORWARD` chain accepts it. Symptom: host can reach pods, pods cannot reach Services or CoreDNS, cert-manager never issues. Check `sudo nft list ruleset | grep -B2 'policy drop'` before you start. A clean VPS avoids all of this.

## 1. DNS

Create two A records pointing at the VPS: one for the API, one for agent-fs. Examples below use `swarm-api.example.com` and `swarm-files.example.com`. Wait until `dig +short` returns the IP from a public resolver.

## 2. Cluster and add-ons

```bash
ssh <vps>
curl -sfL https://get.k3s.io | sudo INSTALL_K3S_EXEC="--disable traefik --disable servicelb" sh -
sudo chmod 644 /etc/rancher/k3s/k3s.yaml
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | sudo bash

helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx -n ingress-nginx --create-namespace \
  --set controller.service.type=NodePort \
  --set controller.service.nodePorts.http=30080 \
  --set controller.service.nodePorts.https=30443 \
  --set controller.ingressClassResource.default=true --wait
helm upgrade --install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --set crds.enabled=true --wait

kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: <you@example.com>
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
EOF
kubectl get clusterissuer   # READY must be True; if not, see step 6
```

If nothing else listens on 80/443, skip the NodePort flags and the proxy in step 3, and use a LoadBalancer or hostPort service instead.

## 3. Host proxy in front of the NodePorts

When a host Caddy owns 80/443, add these blocks. The HTTPS block proxies to the in-cluster nginx over TLS so the certificate that cert-manager issued is the one actually served. The plain-HTTP block passes ACME HTTP-01 challenges through to the cluster so cert-manager can complete them.

```caddyfile
swarm-api.example.com, swarm-files.example.com {
	reverse_proxy https://127.0.0.1:30443 {
		transport http {
			tls_insecure_skip_verify
			tls_server_name {host}
		}
		header_up Host {host}
	}
}
http://swarm-api.example.com, http://swarm-files.example.com {
	reverse_proxy 127.0.0.1:30080
}
```

`sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy`. Back the file up first.

## 4. Install the chart

From your checkout, copy the chart and write an overlay for the hostnames. Keep secrets in a Kubernetes Secret, never in values.

```bash
scp -r charts/agent-swarm <vps>:~/swarm-test/chart
cat > overlay.yaml <<'EOF'
auth:
  existingSecret: agent-swarm-secrets
config:
  publicMcpBaseUrl: https://swarm-api.example.com
ingress:
  host: swarm-api.example.com
agentFs:
  ingress:
    host: swarm-files.example.com
EOF
scp overlay.yaml <vps>:~/swarm-test/

ssh <vps>
cd ~/swarm-test
printf 'API_KEY=%s\nSECRETS_ENCRYPTION_KEY=%s\nCLAUDE_CODE_OAUTH_TOKEN=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" "<token>" > swarm-secrets.env
chmod 600 swarm-secrets.env
kubectl create namespace agent-swarm
kubectl -n agent-swarm create secret generic agent-swarm-secrets --from-env-file=swarm-secrets.env
helm upgrade --install swarm ./chart -n agent-swarm \
  -f chart/examples/values-all-workers-agent-fs.yaml -f overlay.yaml --timeout 15m
```

The example values enable every official pool, agent-fs on local disk, and cert-manager on both ingresses. Expect 12 pool pods plus the API and agent-fs.

## 5. Verify

Run these on the VPS or anywhere with the API key. Every line must pass.

```bash
kubectl -n agent-swarm get pods,certificate            # all 1/1 Running, both certificates READY=True
curl -fsS https://swarm-api.example.com/health           # 200 {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' https://swarm-api.example.com/   # 401: unknown paths are fail-closed
curl -fsS https://swarm-files.example.com/health         # 200
curl -s -H "Authorization: Bearer $API_KEY" https://swarm-api.example.com/api/agents | jq '.agents | length'   # pool count
curl -s -H "Authorization: Bearer $API_KEY" https://swarm-api.example.com/api/fs/capabilities | jq .providerId  # "agent-fs"
curl -s -X POST -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"task":"smoke test: reply with SWARM_K8S_OK and the output of hostname. Do not create files or PRs."}' \
  https://swarm-api.example.com/api/tasks | jq .id
```

Then open `https://app.agent-swarm.dev`, connect with the API URL and key, and confirm the agent list loads. That step is the one prospects fail on: it needs a public `https://` origin on the API and no CORS error. Poll `GET /api/tasks/<id>` until the task is `completed`.

## 6. Things that went wrong the first time

| Symptom | Cause | Fix |
|---|---|---|
| ClusterIssuer `READY=False`, "lookup acme-v02.api.letsencrypt.org: i/o timeout" | Pod networking was broken when cert-manager registered | Fix networking (step 0), then `kubectl -n cert-manager rollout restart deploy/cert-manager` |
| Pods `0/1 Running` for minutes, a StatefulSet with `replicas: 2` never creates ordinal 1 | Readiness probe `pgrep` exceeded its timeout under boot load | Fixed in the chart (`timeoutSeconds: 5`). On older charts wait for load to drop |
| `[seed:agent-fs-provision] FAILED ... timed out` in API logs | API could not reach the agent-fs Service | Networking again. Provisioning is lazy, so restarting the API pod after the fix is enough |
| nginx 504 from the proxy | Same networking cause, nginx could not reach the API pod | Same fix |

## 7. Tear down

```bash
ssh <vps>
helm uninstall swarm -n agent-swarm --wait
sudo /usr/local/bin/k3s-uninstall.sh          # removes cluster, containers, its iptables rules
sudo rm -f /usr/local/bin/helm
# restore the Caddyfile backup and reload caddy
rm -rf ~/swarm-test                            # contains the harness token
```

Delete the two DNS records and any firewall rules you added by hand. k3s-uninstall does not touch nftables tables it did not create.
