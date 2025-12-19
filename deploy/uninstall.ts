#!/usr/bin/env bun

import { $ } from "bun";

await $`systemctl stop agent-swarm agent-swarm-healthcheck.timer`.nothrow();
await $`systemctl disable agent-swarm agent-swarm-healthcheck.timer`.nothrow();
await $`rm -f /etc/systemd/system/agent-swarm.service`;
await $`rm -f /etc/systemd/system/agent-swarm-healthcheck.service`;
await $`rm -f /etc/systemd/system/agent-swarm-healthcheck.timer`;
await $`systemctl daemon-reload`;

console.log("Service removed. Data remains at /opt/agent-swarm");
