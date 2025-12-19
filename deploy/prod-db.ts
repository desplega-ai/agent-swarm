#!/usr/bin/env bun

import { $ } from "bun";
import * as readline from "node:readline";

const DB_PATH = "/opt/agent-swarm/agent-swarm-db.sqlite";
const SSH_HOST = process.argv[2] || "hetzner";

console.log(`Connected to ${SSH_HOST}:${DB_PATH}`);
console.log("Type SQL queries or .tables, .schema, etc. Ctrl+C to exit.\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "sqlite> ",
});

rl.prompt();

rl.on("line", async (line) => {
  const query = line.trim();
  if (!query) {
    rl.prompt();
    return;
  }

  try {
    // Escape single quotes in query and wrap in single quotes for remote shell
    const escaped = query.replace(/'/g, "'\\''");
    const result = await $`ssh ${SSH_HOST} sqlite3 -header -column ${DB_PATH} ${"'" + escaped + "'"}`.text();
    if (result) console.log(result);
  } catch (e: any) {
    console.error(e.stderr?.toString() || e.message);
  }

  rl.prompt();
});

rl.on("close", () => {
  console.log("\nBye!");
  process.exit(0);
});
