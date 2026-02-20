#!/usr/bin/env bun
// wts setup script - runs after worktree creation
//
// Environment variables:
//   WTS_WORKTREE_PATH - path to the new worktree (also the working directory)
//   WTS_GIT_ROOT      - path to the main repository root

import { exists, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

const worktreePath = process.env.WTS_WORKTREE_PATH!;
const gitRoot = process.env.WTS_GIT_ROOT!;
const worktreeName = basename(worktreePath);

console.log(`Setting up worktree "${worktreeName}" at ${worktreePath}...`);

// Generate a unique port based on worktree index
// Main repo uses 3013, worktrees use 3014+
async function getUniquePort(): Promise<number> {
  const basePort = 3013;
  try {
    // Count existing worktrees to determine port offset
    const worktreesDir = join(gitRoot, ".worktrees");
    if (await exists(worktreesDir)) {
      const worktrees = await readdir(worktreesDir);
      return basePort + worktrees.length;
    }
  } catch {
    // Fallback: use a hash of the worktree name
    let hash = 0;
    for (const char of worktreeName) {
      hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    }
    return basePort + 1 + (Math.abs(hash) % 100);
  }
  return basePort + 1;
}

const port = await getUniquePort();
const uiPort = port + 1000; // UI on a different port to avoid conflicts

console.log(`Using port ${port} for this worktree`);

// --- Copy and configure .env ---
const mainEnv = join(gitRoot, ".env");
const envExample = join(worktreePath, ".env.example");
const targetEnv = join(worktreePath, ".env");

if (await exists(mainEnv)) {
  console.log("Copying .env from main repo...");
  let envContent = await readFile(mainEnv, "utf-8");

  // Update PORT to the unique port
  envContent = envContent.replace(/^PORT=\d+/m, `PORT=${port}`);
  // Replace ":{PORT}" too
  envContent = envContent.replace(/:\d+/g, `:${port}`);
  // Change APP_URL=http://localhost:{baseUiPort} to use {uiPort}
  envContent = envContent.replace(/APP_URL=http:\/\/localhost:\d+/m, `APP_URL=http://localhost:${uiPort}`);

  await writeFile(targetEnv, envContent);
} else if (await exists(envExample)) {
  console.log("Creating .env from .env.example...");
  let envContent = await readFile(envExample, "utf-8");

  envContent = envContent.replace(/^PORT=\d+/m, `PORT=${port}`);
  // Replace ":{PORT}" too
  envContent = envContent.replace(/:\d+/g, `:${port}`);
  // Change APP_URL=http://localhost:{baseUiPort} to use {uiPort}
  envContent = envContent.replace(/APP_URL=http:\/\/localhost:\d+/m, `APP_URL=http://localhost:${uiPort}`);

  await writeFile(targetEnv, envContent);
}

// --- Copy and configure .mcp.json ---
const mainMcp = join(gitRoot, ".mcp.json");
const targetMcp = join(worktreePath, ".mcp.json");

if (await exists(mainMcp)) {
  console.log("Copying .mcp.json with updated port...");
  let mcpContent = await readFile(mainMcp, "utf-8");
  // Update the port in the MCP URL
  mcpContent = mcpContent.replace(/localhost:\d+/g, `localhost:${port}`);
  await writeFile(targetMcp, mcpContent);
}

const mainQa = join(gitRoot, ".qa-use-tests.json");
const targetQa = join(worktreePath, ".qa-use-tests.json");

if (await exists(mainQa)) {
  console.log("Copying .qa-use-tests.json...");
  let qaContent = await readFile(mainQa, "utf-8");
  await writeFile(targetQa, qaContent);
}

// --- Copy .claude directory ---
const mainClaude = join(gitRoot, ".claude");
const targetClaude = join(worktreePath, ".claude");

if (await exists(mainClaude)) {
  console.log("Copying .claude directory...");
  await mkdir(targetClaude, { recursive: true });
  const files = await readdir(mainClaude);
  for (const file of files) {
    const content = await readFile(join(mainClaude, file));
    await writeFile(join(targetClaude, file), content);
  }
}

// --- Copy docker env files if they exist ---
const dockerEnvFiles = [".env.docker", ".env.docker-lead"];
for (const envFile of dockerEnvFiles) {
  const mainDockerEnv = join(gitRoot, envFile);
  const targetDockerEnv = join(worktreePath, envFile);
  if (await exists(mainDockerEnv)) {
    console.log(`Copying ${envFile}...`);
    await Bun.$`cp ${mainDockerEnv} ${targetDockerEnv}`;
  }
}

// --- Install dependencies ---
console.log("Installing dependencies...");
await Bun.$`bun install`;

console.log(`\nSetup complete! Worktree running on port ${port}`);
console.log(`Start the server with: bun run dev:http`);
