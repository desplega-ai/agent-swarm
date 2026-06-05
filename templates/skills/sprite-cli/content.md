# sprite-cli

`sprite` is a CLI for [sprites.dev](https://sprites.dev) — ephemeral Linux sandboxes backed by Fly.io firecracker microVMs. Use them when you need to run docker, docker-compose, postgres, redis, or anything else the host swarm container won't let you do.

## When to use this

- You need to test a `docker run …` or `docker compose up …` flow.
- You need a real postgres / redis / rabbitmq for an integration test.
- You want to try an `apt-get install` of something you don't want polluting the swarm container.
- You need to fetch + execute untrusted code (sandboxed network egress is OK; egress to swarm internals is not).

If you can do it directly in the swarm container (lint, type-check, unit test, code search), don't reach for sprite — it's slower and uses paid resources.

## Installation

The CLI is auto-installed at container start for agents whose setup script includes the install snippet (see "Setup script snippet" below).

Manual install:
```bash
curl -fsSL https://sprites.dev/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"   # CLI lands in ~/.local/bin
```

## Authentication

The org token is stored in swarm config as `SPRITES_API_KEY` (global, secret). Setup scripts read `$SPRITES_API_KEY` from the env.

```bash
sprite auth setup --token "$SPRITES_API_KEY"
```

Token format is `<org>/<account_id>/<token_id>/<secret>`. The first segment is your organization slug.

## Core commands

| Command | What it does |
|---|---|
| `sprite create <name>` | Create a sprite (~1s). |
| `sprite list` | List your sprites. |
| `sprite exec -s <name> -- <cmd>` | Run a command in the sprite. |
| `sprite exec -s <name> -- bash -c "…"` | Run a multi-statement shell snippet. |
| `sprite console -s <name>` | Open an interactive shell. |
| `sprite destroy <name> --force` | Tear down. **Always do this when done.** |
| `sprite proxy <port>` | Forward a remote sprite port to your local machine (rarely useful from within a swarm container; prefer curl from inside the sprite). |

Flags: every command takes `-s <sprite>` (or sets a default via `sprite use`). `-o <org>` overrides the org if you have multiple.

## Sandbox baseline

- Ubuntu-based microVM image (exact version may change over time)
- Non-root `sprite` user (uid 1001), passwordless `sudo`
- No docker, no `/var/run/docker.sock`, no container runtime preinstalled
- No systemd / init — `service` and `systemctl` won't work; start daemons manually with `sudo <daemon> &` or `nohup`
- Kernel sysctls are mostly read-only (e.g. `vm.mmap_min_addr` writes fail — these warnings are harmless)

## Recipe: docker inside a sprite

```bash
sprite create dock
sprite exec -s dock -- bash -c '
  set -e
  sudo apt-get update -qq
  sudo apt-get install -y docker.io docker-compose-v2
  sudo dockerd > /tmp/dockerd.log 2>&1 &
  # wait for daemon
  for i in {1..15}; do sudo docker ps >/dev/null 2>&1 && break; sleep 1; done
  sudo docker run --rm hello-world
'
```

Notes:
- `invoke-rc.d` and `policy-rc.d denied` warnings during `apt-get install` are harmless — they come from missing systemd; the binaries install fine.
- The `sprite` user is **not** in the docker group by default, so prefix every docker call with `sudo`. (You can `sudo usermod -aG docker sprite` and start a new shell, but for one-off scripts `sudo` is simpler.)
- `dockerd` binds to `/var/run/docker.sock`. If you need it on a TCP port, pass `-H tcp://0.0.0.0:2375` (only inside the sprite — this is not exposed to the public internet).

## Recipe: docker compose

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
  sudo docker exec $(sudo docker compose -f /tmp/compose.yml ps -q pg) psql -U postgres -c "select version();"
  sudo docker compose -f /tmp/compose.yml down -v
'
```

Use `docker compose` (v2 plugin) — `docker-compose` (legacy v1) is not installed.

## Cleanup discipline (mandatory)

Sprites are paid resources. **Always destroy them.** Pattern:

```bash
sprite create test-$$
trap "sprite destroy test-$$ --force" EXIT INT TERM
# … work …
```

If a script crashes, `sprite list` shows what's still up. Sweep with `sprite list -o <org>` and destroy anything you don't recognize.

## Setup script snippet

Drop this into an agent's setup script to auto-install + auth on container boot:

```bash
# Sprite CLI — sandboxes for docker/postgres/etc.
if [ ! -x "$HOME/.local/bin/sprite" ]; then
  curl -fsSL https://sprites.dev/install.sh | sh -s -- 2>/dev/null || true
fi
if [ -n "$SPRITES_API_KEY" ] && [ -x "$HOME/.local/bin/sprite" ]; then
  "$HOME/.local/bin/sprite" auth setup --token "$SPRITES_API_KEY" 2>/dev/null || true
fi
# Make sprite findable in non-login shells
grep -q '/.local/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
```

## Common gotchas

- **PATH:** the installer drops the binary in `~/.local/bin`. Non-login bash shells often miss it. Always export PATH or use the absolute path.
- **No keyring:** the CLI warns "No system keyring available. Storing secrets unencrypted in ~/.sprites/keyring/". This is expected in a container; the file is mode 600 and only readable by the agent user.
- **Daemon survival:** `sprite exec` runs in a fresh subshell. A daemon backgrounded with `&` survives the exec call (sprites use a shared init), but if you want to be safe use `nohup`. To stop it, `sprite exec -s … -- sudo pkill <daemon>`.
- **Port forwarding:** ports inside the sprite are not exposed to your swarm container. Curl from *inside* the sprite (`sprite exec -s … -- curl localhost:5432`) — not from your container.
- **Don't leak secrets:** treat the sprite as an untrusted host. Don't put production tokens in there.
