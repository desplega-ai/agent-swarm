#!/usr/bin/env bun

import { $ } from "bun";

const APP_DIR = "/opt/agent-swarm";
const SCRIPT_DIR = import.meta.dir;
const PROJECT_DIR = `${SCRIPT_DIR}/..`;

console.log("Updating agent-swarm...");

// Copy project files
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

// Restart service
await $`systemctl restart agent-swarm`;

console.log("Updated and restarted.");
