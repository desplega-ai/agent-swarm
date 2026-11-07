# DigitalOcean Marketplace 1-Click image for Agent Swarm.
#
# Follows the digitalocean/marketplace-partners layout: files/ is copied onto
# the image, scripts/ runs in order, and 90-cleanup.sh plus 99-img-check.sh
# come from that repository unchanged. First boot runs deploy/one-box/bootstrap.sh
# (the same script as deploy/cloud-init.yaml) from the per-instance hook.
#
#   packer init deploy/digitalocean
#   DIGITALOCEAN_TOKEN=... packer build deploy/digitalocean
#
# See deploy/digitalocean/README.md.

packer {
  required_plugins {
    digitalocean = {
      version = ">= 1.4.0"
      source  = "github.com/digitalocean/digitalocean"
    }
  }
}

variable "do_token" {
  type      = string
  default   = env("DIGITALOCEAN_TOKEN")
  sensitive = true
}

variable "region" {
  type    = string
  default = "nyc3"
}

# The snapshot's disk is the build Droplet's disk, and a Droplet created from it
# needs at least that much. 80 GB keeps every size from 4 GB RAM upward open.
variable "size" {
  type    = string
  default = "s-2vcpu-4gb"
}

variable "base_image" {
  type    = string
  default = "ubuntu-24-04-x64"
}

variable "application_name" {
  type    = string
  default = "Agent Swarm"
}

variable "application_version" {
  type    = string
  default = "latest"
}

locals {
  snapshot_name = "agent-swarm-24-04-snapshot-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  apt_env = [
    "DEBIAN_FRONTEND=noninteractive",
    "LC_ALL=C",
    "LANG=en_US.UTF-8",
    "LC_CTYPE=en_US.UTF-8",
  ]
}

source "digitalocean" "agent_swarm" {
  api_token     = var.do_token
  image         = var.base_image
  region        = var.region
  size          = var.size
  ssh_username  = "root"
  snapshot_name = local.snapshot_name
}

build {
  sources = ["source.digitalocean.agent_swarm"]

  provisioner "shell" {
    inline = ["cloud-init status --wait || true"]
  }

  provisioner "file" {
    source      = "${path.root}/files/etc/"
    destination = "/etc/"
  }

  provisioner "file" {
    source      = "${path.root}/files/var/"
    destination = "/var/"
  }

  provisioner "shell" {
    inline = ["mkdir -p /opt/agent-swarm"]
  }

  provisioner "file" {
    source      = "${path.root}/../one-box/bootstrap.sh"
    destination = "/opt/agent-swarm/bootstrap.sh"
  }

  provisioner "shell" {
    environment_vars = local.apt_env
    inline = [
      "apt-get -qqy update",
      "apt-get -qqy -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' full-upgrade",
      "apt-get -qqy clean",
    ]
  }

  provisioner "shell" {
    environment_vars = concat(local.apt_env, [
      "application_name=${var.application_name}",
      "application_version=${var.application_version}",
    ])
    scripts = [
      "${path.root}/scripts/01-agent-swarm.sh",
      "${path.root}/scripts/02-ufw.sh",
      "${path.root}/scripts/03-force-ssh-logout.sh",
      "${path.root}/scripts/90-cleanup.sh",
      "${path.root}/scripts/99-img-check.sh",
    ]
  }
}
