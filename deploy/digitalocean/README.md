# DigitalOcean Marketplace 1-Click image

A Packer template that builds the Agent Swarm 1-Click Droplet image. It follows the
[digitalocean/marketplace-partners](https://github.com/digitalocean/marketplace-partners)
layout, so DigitalOcean's review tooling reads it the way it reads their sample.

| Path | What it does |
|---|---|
| `agent-swarm.pkr.hcl` | Builds a snapshot from Ubuntu 24.04 on an `s-2vcpu-4gb` Droplet (80 GB disk). |
| `scripts/01-agent-swarm.sh` | Installs Docker, Compose v2, Caddy (stopped) and ufw. Pre-pulls the API and worker images. |
| `scripts/02-ufw.sh` | Opens 22, 80 and 443 only, then enables ufw. |
| `scripts/03-force-ssh-logout.sh`, `90-cleanup.sh`, `99-img-check.sh` | Copied unchanged from marketplace-partners @ `b70878804ca2` (Apache 2.0, see `scripts/LICENSE-marketplace-partners.md`). |
| `files/var/lib/cloud/scripts/per-instance/001_onboot` | First boot: runs `/opt/agent-swarm/bootstrap.sh`, then lets root SSH in. |
| `files/etc/update-motd.d/99-one-click` | Login message. It shows where the setup link is, never the link itself. |

First boot runs [`deploy/one-box/bootstrap.sh`](../one-box/bootstrap.sh), the same script that
[`deploy/cloud-init.yaml`](../cloud-init.yaml) runs on any VPS. It points Caddy at
`<droplet-ip>.sslip.io`, runs `install.sh --no-tunnel --public-url https://<host> --bind 127.0.0.1`,
and writes the dashboard `/setup` link to `/root/agent-swarm-setup-link.txt` (mode 600). A root
login prints the link. A user who wants their own domain adds this user data when creating the
Droplet:

```yaml
#cloud-config
write_files:
  - path: /etc/agent-swarm/deploy.env
    permissions: "0600"
    content: |
      SWARM_DOMAIN=swarm.example.com
```

## Validate

```bash
packer init deploy/digitalocean
DIGITALOCEAN_TOKEN=unused packer validate deploy/digitalocean
```

`validate` needs some token value; it does not call the API.

## Build (human step)

The token needs write scope.

```bash
DIGITALOCEAN_TOKEN=<token> packer build deploy/digitalocean
```

The build creates a temporary Droplet, snapshots it and deletes it. `99-img-check.sh` must end with
no failures.

## List it (human steps)

1. Create the vendor account in the [Marketplace Vendor Portal](https://cloud.digitalocean.com/vendorportal) and submit the tax form for desplega's entity.
2. Submit the snapshot with the app name, version, 4 vCPU / 8 GB as the recommended size, and the getting-started text from the [one-click deploy guide](https://docs.agent-swarm.dev/docs/guides/one-click-deploy).
3. After review passes, replace the DigitalOcean placeholder in that guide with the real "Deploy to DigitalOcean" button.
