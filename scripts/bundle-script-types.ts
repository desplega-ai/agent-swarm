#!/usr/bin/env bun
import { closeDb } from "@swarm/storage";
import { SCRIPT_SDK_TYPES, SCRIPT_STDLIB_TYPES } from "@swarm/storage";
import { createServer } from "../src/server";
// Import the allowlist module DIRECTLY (not via the @swarm/scripts barrel): the barrel
// re-exports eval-harness.ts, whose top-level code calls requiredEnv("SWARM_SCRIPT_TMPDIR")
// and throws outside the sandbox subprocess. This generator only needs the SDK metadata.
import { SDK_ALLOWLIST, mcpToolNameForSdkMethod } from "../packages/scripts/src/scripts-runtime/sdk-allowlist";

type RegisteredTools = Record<string, unknown>;

async function main() {
  process.env.DATABASE_PATH ??= "/tmp/agent-swarm-script-types.sqlite";
  const server = createServer();
  const tools = (server as unknown as { _registeredTools: RegisteredTools })._registeredTools;
  const missing = SDK_ALLOWLIST.map((name) => mcpToolNameForSdkMethod(name)).filter(
    (name) => !(name in tools),
  );

  if (missing.length > 0) {
    throw new Error(`SDK_ALLOWLIST points at missing MCP tools: ${missing.join(", ")}`);
  }

  await Bun.$`mkdir -p packages/scripts/src/scripts-runtime/types`;
  await Bun.write(
    "packages/scripts/src/scripts-runtime/types/swarm-sdk.d.ts",
    `declare module "swarm-sdk" {\n${SCRIPT_SDK_TYPES.replace(/^/gm, "  ")}\n}\n`,
  );
  await Bun.write(
    "packages/scripts/src/scripts-runtime/types/stdlib.d.ts",
    SCRIPT_STDLIB_TYPES.trimStart(),
  );
  await Bun.$`bunx biome format --write packages/scripts/src/scripts-runtime/types/swarm-sdk.d.ts packages/scripts/src/scripts-runtime/types/stdlib.d.ts`;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
