#!/usr/bin/env bun
// wts setup script - runs after worktree creation
//
// Environment variables:
//   WTS_WORKTREE_PATH - path to the new worktree (also the working directory)
//   WTS_GIT_ROOT      - path to the main repository root

import { exists, readFile, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

const worktreePath = process.env.WTS_WORKTREE_PATH!;
const gitRoot = process.env.WTS_GIT_ROOT!;
const worktreeName = basename(worktreePath);

console.log(`Setting up worktree "${worktreeName}" at ${worktreePath}...`);

// Pick a random available port in 3100-3999
async function getRandomPort(maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = 3100 + Math.floor(Math.random() * 900);
    const available = await isPortAvailable(port);
    if (available) return port;
  }
  // Final fallback: hash-based port from worktree name
  let hash = 0;
  for (const char of worktreeName) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return 3100 + (Math.abs(hash) % 900);
}

async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const result = await Bun.$`lsof -i :${port} -t`.quiet();
    // If lsof returns output, port is in use
    return result.stdout.toString().trim() === "";
  } catch {
    // lsof exits non-zero when nothing found — port is available
    return true;
  }
}

// --- Copy and configure .env ---
const mainEnv = join(gitRoot, ".env");
const envExample = join(worktreePath, ".env.example");
const targetEnv = join(worktreePath, ".env");

// Read main .env to detect portless mode
const mainEnvContent = (await exists(mainEnv))
  ? await readFile(mainEnv, "utf-8")
  : (await exists(envExample))
    ? await readFile(envExample, "utf-8")
    : "";

const isPortless = mainEnvContent.includes("localhost:1355");
const slug = worktreeName.replace(/[^a-z0-9-]/gi, "-").toLowerCase();

if (isPortless) {
  console.log(`Portless mode: using ${slug}.api.swarm.localhost:1355`);
} else {
  console.log(`Port mode: allocating unique port`);
}

const port = isPortless ? 0 : await getRandomPort();
const uiPort = isPortless ? 0 : port + 1000;

if (!isPortless) {
  console.log(`Using port ${port} for this worktree`);
}

if (mainEnvContent) {
  console.log(
    (await exists(mainEnv))
      ? "Copying .env from main repo..."
      : "Creating .env from .env.example...",
  );
  let envContent = mainEnvContent;

  if (isPortless) {
    // Rewrite portless URLs with worktree subdomain
    envContent = envContent.replace(
      /(MCP_BASE_URL=https?:\/\/)([\w.-]*)(api\.swarm\.localhost:1355)/m,
      `$1${slug}.$3`,
    );
    envContent = envContent.replace(
      /(APP_URL=https?:\/\/)([\w.-]*)(ui\.swarm\.localhost:1355)/m,
      `$1${slug}.$3`,
    );
    envContent = envContent.replace(
      /(LINEAR_REDIRECT_URI=https?:\/\/)([\w.-]*)(api\.swarm\.localhost:1355)/m,
      `$1${slug}.$3`,
    );
  } else {
    // Port-based rewriting (existing logic)
    envContent = envContent.replace(/^PORT=\d+/m, `PORT=${port}`);
    envContent = envContent.replace(/:\d+/g, `:${port}`);
    envContent = envContent.replace(
      /APP_URL=http:\/\/localhost:\d+/m,
      `APP_URL=http://localhost:${uiPort}`,
    );
  }

  await writeFile(targetEnv, envContent);
}

// --- Copy and configure .mcp.json ---
const mainMcp = join(gitRoot, ".mcp.json");
const targetMcp = join(worktreePath, ".mcp.json");

if (await exists(mainMcp)) {
  console.log("Copying .mcp.json with updated URL...");
  let mcpContent = await readFile(mainMcp, "utf-8");

  if (isPortless) {
    mcpContent = mcpContent.replace(
      /https?:\/\/[\w.-]*api\.swarm\.localhost:1355/g,
      `https://${slug}.api.swarm.localhost:1355`,
    );
  } else {
    mcpContent = mcpContent.replace(/localhost:\d+/g, `localhost:${port}`);
  }

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
  await Bun.$`rm -rf ${targetClaude} && cp -r ${mainClaude} ${targetClaude}`;
}

// --- Copy .business-use directory (BU config + DB) ---
const mainBu = join(gitRoot, ".business-use");
const targetBu = join(worktreePath, ".business-use");

if (await exists(mainBu)) {
  console.log("Copying .business-use directory...");
  await Bun.$`cp -r ${mainBu} ${targetBu}`;
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

if (isPortless) {
  console.log(`\nSetup complete! Worktree using portless subdomain: ${slug}`);
  console.log(`API: https://${slug}.api.swarm.localhost:1355`);
  console.log(`UI:  https://${slug}.ui.swarm.localhost:1355`);
} else {
  console.log(`\nSetup complete! Worktree running on port ${port}`);
}
console.log(`Start the server with: bun run dev:http`);
