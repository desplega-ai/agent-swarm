import { buildCtx } from "./ctx";
import type { SwarmConfigPayload } from "./executors/types";
import { SwarmConfig } from "./swarm-config";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

try {
  const stdin = await Bun.stdin.text();
  if (!stdin.trim()) {
    console.error("Swarm script config payload was empty");
    process.exit(2);
  }

  const payload = JSON.parse(stdin) as SwarmConfigPayload;
  const swarmConfig = new SwarmConfig(payload);
  const rawArgs = JSON.parse(await Bun.file(requiredEnv("SWARM_SCRIPT_ARGS_FILE")).text());
  // Accept both shapes: callers may pass an already-serialized JSON string.
  const parsedArgs = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
  const ctx = buildCtx({ swarmConfig });

  const sourceText = await Bun.file(requiredEnv("SWARM_SCRIPT_SOURCE_FILE")).text();
  const userModulePath = `${requiredEnv("SWARM_SCRIPT_TMPDIR")}/user-script.ts`;
  await Bun.write(userModulePath, sourceText);

  const mod = await import(userModulePath);
  if (typeof mod.default !== "function") {
    throw new Error("Swarm script must export a default function");
  }

  const result = await mod.default(parsedArgs, ctx);
  await Bun.write(requiredEnv("SWARM_SCRIPT_RESULT_FILE"), JSON.stringify(result ?? null));
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
