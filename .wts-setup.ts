#!/usr/bin/env bun
// wts setup script - runs after worktree creation
//
// Environment variables:
//   WTS_WORKTREE_PATH - path to the new worktree (also the working directory)
//   WTS_GIT_ROOT      - path to the main repository root

import { exists } from "node:fs/promises";

const worktreePath = process.env.WTS_WORKTREE_PATH!;
const gitRoot = process.env.WTS_GIT_ROOT!;

console.log(`Setting up worktree at ${worktreePath}...`);

// Copy .env from main repo if it exists, otherwise use .env.example
const mainEnv = `${gitRoot}/.env`;
const envExample = `${worktreePath}/.env.example`;
const targetEnv = `${worktreePath}/.env`;

if (await exists(mainEnv)) {
  console.log("Copying .env from main repo...");
  await Bun.$`cp ${mainEnv} ${targetEnv}`;
} else if (await exists(envExample)) {
  console.log("Creating .env from .env.example...");
  await Bun.$`cp ${envExample} ${targetEnv}`;
}

// Install dependencies
console.log("Installing dependencies...");
await Bun.$`bun install`;

console.log("Setup complete!");
