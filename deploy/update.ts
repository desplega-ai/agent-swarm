#!/usr/bin/env bun

import { $ } from "bun";

const APP_DIR = "/opt/agent-swarm";
const SCRIPT_DIR = import.meta.dir;
const PROJECT_DIR = `${SCRIPT_DIR}/..`;

console.log("Updating agent-swarm...");

// Copy project files
await $`cp -r ${PROJECT_DIR}/src ${APP_DIR}/`;
await $`cp ${PROJECT_DIR}/package.json ${PROJECT_DIR}/bun.lock ${PROJECT_DIR}/tsconfig.json ${APP_DIR}/`;

// Install dependencies
await $`cd ${APP_DIR} && bun install --frozen-lockfile --production`;

// Restart service
await $`systemctl restart agent-swarm`;

console.log("Updated and restarted.");
