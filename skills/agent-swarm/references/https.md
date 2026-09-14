# HTTPS for the API and agent-fs

The hosted dashboard at `https://app.agent-swarm.dev` is served over HTTPS. Browsers block a plain-HTTP API as mixed content.
OAuth redirects, inbound webhooks, and page links also need a public HTTPS origin.
Set `PUBLIC_MCP_BASE_URL` to that origin. Workers keep the internal `MCP_BASE_URL`.
Read the [Kubernetes guide](https://docs.agent-swarm.dev/docs/guides/kubernetes) and the [deployment guide](https://docs.agent-swarm.dev/docs/guides/deployment).

## Compose: bundled Caddy

The [Compose example](https://github.com/desplega-ai/agent-swarm/blob/main/docker-compose.example.yml) contains a `caddy` service under the `tls` profile.
Caddy obtains Let's Encrypt certificates and proxies `SWARM_API_DOMAIN` to `api:3013` and `AGENT_FS_DOMAIN` to `agent-fs:7433`.
Point DNS for both domains at the host. Open ports 80 and 443. Docker Compose v2.23.1 or newer is required.

```bash
cat >> .env <<'ENV'
SWARM_API_DOMAIN=swarm-api.example.com
AGENT_FS_DOMAIN=swarm-files.example.com
PUBLIC_MCP_BASE_URL=https://swarm-api.example.com
ENV
docker compose -f docker-compose.example.yml --env-file .env --profile tls up -d
curl -fsS https://swarm-api.example.com/health
```

After Caddy runs, block public access to host ports 3013 and 7433.
When another proxy already terminates TLS, skip the profile and set only `PUBLIC_MCP_BASE_URL`.

## Kubernetes: cert-manager

The chart adds the cert-manager annotation, generates the `tls` entry, and derives an `https://` public URL when an issuer is named.
No TLS Secret is created by hand. Install [cert-manager](https://cert-manager.io/docs/installation/) and create a ClusterIssuer first.
Read the [chart HTTPS section](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/README.md).

```yaml
ingress:
  enabled: true
  className: nginx
  host: swarm-api.example.com
  certManager:
    clusterIssuer: letsencrypt-prod
agentFs:
  ingress:
    enabled: true
    className: nginx
    host: swarm-files.example.com
    certManager:
      clusterIssuer: letsencrypt-prod
```

Use `certManager.issuer` for a namespaced Issuer. Explicit `ingress.tls` entries take precedence.
A complete example is in [values-all-workers-agent-fs.yaml](https://github.com/desplega-ai/agent-swarm/blob/main/charts/agent-swarm/examples/values-all-workers-agent-fs.yaml).

## Kubernetes: another certificate source

An ingress controller with built-in ACME (Traefik, Caddy ingress controller) or a proxy in front of the cluster can terminate TLS.
In that case leave `certManager` blank, add the controller annotations under `ingress.annotations`, and set the public origin explicitly:

```yaml
config:
  publicMcpBaseUrl: https://swarm-api.example.com
```

An empty `ingress.tls` with no issuer derives an `http://` public URL. Set `config.publicMcpBaseUrl` whenever TLS is not visible to the chart.

## Verify

```bash
curl -fsS https://swarm-api.example.com/health
curl -fsS https://swarm-files.example.com/health
```

Open `https://app.agent-swarm.dev`, enter the API URL and key, and confirm the agent list loads without a mixed-content or CORS error.
