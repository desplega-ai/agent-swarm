# Deployment

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3013` | Server port |
| `API_KEY` | _(empty)_ | Bearer token for auth (optional) |

## Docker

```bash
# Build
docker build -t agent-swarm .

# Run (persists database to ./agent-swarm-db.sqlite on host)
docker run -d --name agent-swarm -p 3013:3013 \
  -e API_KEY=your-secret-key \
  -v $(pwd)/agent-swarm-db.sqlite:/app/agent-swarm-db.sqlite \
  agent-swarm
```

## systemd

```bash
# Install service
sudo bun deploy/install.ts

# Control
sudo systemctl start agent-swarm
sudo systemctl stop agent-swarm
sudo systemctl status agent-swarm
journalctl -u agent-swarm -f

# Health check timer (runs every 30s, auto-restarts on failure)
sudo systemctl status agent-swarm-healthcheck.timer

# Uninstall
sudo bun deploy/uninstall.ts
```

## Caddy (reverse proxy)

Add to your Caddyfile:

```
agent-swarm.example.com {
    reverse_proxy localhost:3013
}
```

Or with API key header injection:

```
agent-swarm.example.com {
    reverse_proxy localhost:3013 {
        header_up Authorization "Bearer {env.AGENT_SWARM_API_KEY}"
    }
}
```
