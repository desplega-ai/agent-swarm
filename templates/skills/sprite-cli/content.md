# Sprite CLI

`sprite` is a CLI for [sprites.dev](https://sprites.dev) — ephemeral Linux sandboxes backed by Fly.io firecracker microVMs. Use them when you need to run docker, docker-compose, postgres, redis, or anything else the host swarm container won't let you do.

## When to Use This

- You need to test a `docker run` or `docker compose up` flow.
- You need a real postgres / redis / rabbitmq for an integration test.
- You want to `apt-get install` something without polluting the swarm container.
- You need to fetch + execute untrusted code.

If you can do it directly in the swarm container (lint, type-check, unit test, code search), don't reach for sprite — it's slower and uses paid resources.

## Authentication

The org token is stored in swarm config as `SPRITES_API_KEY` (global, secret).

```bash
sprite auth setup --token "$SPRITES_API_KEY"
```

## Core Commands

| Command | What it does |
|---|---|
| `sprite create <name>` | Create a sprite (~1s). |
| `sprite list` | List your sprites. |
| `sprite exec -s <name> -- <cmd>` | Run a command in the sprite. |
| `sprite exec -s <name> -- bash -c "…"` | Run a multi-statement shell snippet. |
| `sprite destroy <name> --force` | Tear down. **Always do this when done.** |

## Sandbox Baseline

- Ubuntu 25.10 (Questing Quokka), kernel 6.12.x
- Non-root `sprite` user (uid 1001), passwordless `sudo`
- **No docker preinstalled** — install with `sudo apt-get install docker.io`
- No systemd — start daemons manually with `sudo <daemon> &` or `nohup`

## Recipe: Docker Inside a Sprite

```bash
sprite create dock
sprite exec -s dock -- bash -c '
  set -e
  sudo apt-get update -qq
  sudo apt-get install -y docker.io docker-compose-v2
  sudo dockerd > /tmp/dockerd.log 2>&1 &
  for i in {1..15}; do sudo docker ps >/dev/null 2>&1 && break; sleep 1; done
  sudo docker run --rm hello-world
'
```

Note: the `sprite` user is NOT in the docker group by default — prefix every docker call with `sudo`.

## Recipe: Docker Compose

```bash
sprite exec -s dock -- bash -c '
  cat > /tmp/compose.yml <<YAML
services:
  pg:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: dev
    ports: ["5432:5432"]
YAML
  sudo docker compose -f /tmp/compose.yml up -d
  # wait for healthy
  for i in {1..30}; do sudo docker exec $(sudo docker compose -f /tmp/compose.yml ps -q pg) pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  sudo docker compose -f /tmp/compose.yml down -v
'
```

## Cleanup Discipline (Mandatory)

Sprites are **paid resources**. Always destroy them:

```bash
sprite create test-$$
trap "sprite destroy test-$$ --force" EXIT INT TERM
# ... work ...
```

If a script crashes, `sprite list` shows what's still up. Sweep and destroy anything you don't recognize.

## Setup Script Snippet

Add to your agent's setup script for auto-install + auth on container boot:

```bash
if [ ! -x "$HOME/.local/bin/sprite" ]; then
  curl -fsSL https://sprites.dev/install.sh | sh -s -- 2>/dev/null || true
fi
if [ -n "$SPRITES_API_KEY" ] && [ -x "$HOME/.local/bin/sprite" ]; then
  "$HOME/.local/bin/sprite" auth setup --token "$SPRITES_API_KEY" 2>/dev/null || true
fi
grep -q '/.local/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
```

## Common Gotchas

- **PATH:** the installer drops the binary in `~/.local/bin`. Export PATH or use the absolute path.
- **Port forwarding:** ports inside the sprite are not exposed to your swarm container. Curl from *inside* the sprite — not from your container.
- **Don't leak secrets:** treat the sprite as an untrusted host. Don't put production tokens in there.

## Trade-offs

**Cost:** each sprite is paid. Don't use sprites for tasks you can do locally in the swarm container. The right use case is docker, database integration tests, or tasks requiring an isolated Linux env.

**Setup latency:** ~5–10s to provision plus apt-get install time. Use only when local tooling genuinely can't do the task.
