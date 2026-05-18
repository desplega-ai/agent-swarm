#!/usr/bin/env bun
import { closeDb } from "../src/be/db";
import { SCRIPT_SDK_TYPES, SCRIPT_STDLIB_TYPES } from "../src/be/scripts/typecheck";
import { createServer } from "../src/server";
import { SDK_ALLOWLIST, mcpToolNameForSdkMethod } from "../src/scripts-runtime/sdk-allowlist";

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

  await Bun.$`mkdir -p src/scripts-runtime/types`;
  await Bun.write(
    "src/scripts-runtime/types/swarm-sdk.d.ts",
    `declare module "swarm-sdk" {\n${SCRIPT_SDK_TYPES.replace(/^/gm, "  ")}\n}\n`,
  );
  await Bun.write("src/scripts-runtime/types/stdlib.d.ts", SCRIPT_STDLIB_TYPES.trimStart());
  await Bun.$`bunx biome format --write src/scripts-runtime/types/swarm-sdk.d.ts src/scripts-runtime/types/stdlib.d.ts`;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
