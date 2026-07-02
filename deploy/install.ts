#!/usr/bin/env bun

import { $ } from "bun";

const APP_DIR = "/opt/agent-swarm";
const SERVICE_FILE = "/etc/systemd/system/agent-swarm.service";
const SCRIPT_DIR = import.meta.dir;
const PROJECT_DIR = `${SCRIPT_DIR}/..`;

// Detect bun path
const bunPath = (await $`which bun`.text()).trim();
console.log(`Using bun at: ${bunPath}`);

// Copy project files
await $`mkdir -p ${APP_DIR}`;
await $`mkdir -p ${APP_DIR}/apps/swarm`;
await $`cp -r ${PROJECT_DIR}/apps/swarm/src ${APP_DIR}/apps/swarm/`;
await $`cp ${PROJECT_DIR}/package.json ${PROJECT_DIR}/bun.lock ${PROJECT_DIR}/bunfig.toml ${PROJECT_DIR}/tsconfig.json ${APP_DIR}/`;

// The root manifest declares Bun workspaces, so a frozen install needs every member's
// package.json present to resolve the workspace graph (manifests only — no member code).
await $`mkdir -p ${APP_DIR}/apps/ui ${APP_DIR}/apps/templates-ui ${APP_DIR}/apps/evals`;
await $`cp ${PROJECT_DIR}/apps/ui/package.json ${APP_DIR}/apps/ui/`;
await $`cp ${PROJECT_DIR}/apps/templates-ui/package.json ${APP_DIR}/apps/templates-ui/`;
await $`cp ${PROJECT_DIR}/apps/evals/package.json ${APP_DIR}/apps/evals/`;

// Install dependencies
await $`cd ${APP_DIR} && bun install --frozen-lockfile --production`;

// Create .env if not exists
const envFile = Bun.file(`${APP_DIR}/.env`);
if (!(await envFile.exists())) {
  await Bun.write(
    envFile,
    `PORT=3013
API_KEY=
`,
  );
  console.log("Created .env - set API_KEY for authentication");
}

// Set ownership
await $`chown -R root:root ${APP_DIR}`;

// Install systemd service with detected bun path
const serviceContent = `[Unit]
Description=Agent Swarm MCP Server
After=network.target

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${APP_DIR}
ExecStart=${bunPath} run start:http
ExecStartPost=/bin/sh -c 'sleep 2 && curl -sf http://localhost:3013/health || exit 1'
Restart=always
RestartSec=5
EnvironmentFile=${APP_DIR}/.env

[Install]
WantedBy=multi-user.target
`;

await Bun.write(SERVICE_FILE, serviceContent);

// Healthcheck service (runs curl, restarts main service on failure)
const healthcheckService = `[Unit]
Description=Agent Swarm Health Check

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'curl -sf http://localhost:3013/health || systemctl restart agent-swarm'
`;

// Timer to run healthcheck every 30 seconds
const healthcheckTimer = `[Unit]
Description=Agent Swarm Health Check Timer

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s

[Install]
WantedBy=timers.target
`;

await Bun.write("/etc/systemd/system/agent-swarm-healthcheck.service", healthcheckService);
await Bun.write("/etc/systemd/system/agent-swarm-healthcheck.timer", healthcheckTimer);

await $`systemctl daemon-reload`;
await $`systemctl enable agent-swarm agent-swarm-healthcheck.timer`;
await $`systemctl restart agent-swarm`;
await $`systemctl start agent-swarm-healthcheck.timer`;

console.log("Installed and running with health checks every 30s.");
