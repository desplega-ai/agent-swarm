#!/bin/bash
# Agent Swarm 1-Click image: Docker, Caddy and ufw, plus the two large swarm
# images pre-pulled so first boot is faster. First boot itself runs
# /opt/agent-swarm/bootstrap.sh (deploy/one-box/bootstrap.sh), which skips
# whatever this script already installed.
set -euo pipefail

apt-get -qqy install ca-certificates curl gpg unzip ufw

# Docker Engine and Compose v2.
curl -fsSL https://get.docker.com | sh
systemctl enable docker

# Caddy, stopped until first boot writes a Caddyfile for this Droplet's address.
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
  gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
  >/etc/apt/sources.list.d/caddy-stable.list
chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get -qqy update
apt-get -qqy install caddy
systemctl disable --now caddy

# The compose stack pulls again on first boot (pull_policy: always), so these
# only seed the layer cache. The worker image is most of the ~11 GB.
docker pull ghcr.io/desplega-ai/agent-swarm:latest
docker pull ghcr.io/desplega-ai/agent-swarm-worker:latest

chmod 700 /opt/agent-swarm/bootstrap.sh
chmod 755 /var/lib/cloud/scripts/per-instance/001_onboot /etc/update-motd.d/99-one-click
