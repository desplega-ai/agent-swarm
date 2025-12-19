#!/usr/bin/env bun

import { $ } from "bun";
import pkg from "../package.json";

const IMAGE = "ghcr.io/desplega-ai/agent-swarm-worker";
const VERSION = pkg.version;

console.log(`Publishing ${IMAGE}:${VERSION}...`);

// Login to GHCR using gh CLI
const token = await $`gh auth token`.text();
const username = await $`gh api user -q .login`.text();
await $`echo ${token.trim()} | docker login ghcr.io -u ${username.trim()} --password-stdin`;

// Build
console.log("Building image...");
await $`docker build -f Dockerfile.worker -t agent-swarm-worker .`;

// Tag
console.log(`Tagging as ${VERSION} and latest...`);
await $`docker tag agent-swarm-worker ${IMAGE}:${VERSION}`;
await $`docker tag agent-swarm-worker ${IMAGE}:latest`;

// Push
console.log("Pushing to GHCR...");
await $`docker push ${IMAGE}:${VERSION}`;
await $`docker push ${IMAGE}:latest`;

console.log(`Done! Published ${IMAGE}:${VERSION}`);
