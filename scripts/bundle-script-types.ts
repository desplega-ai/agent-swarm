#!/usr/bin/env bun
import { closeDb } from "../src/be/db";
import {
  SCRIPT_STDLIB_TYPES,
  scriptSdkTypesWithGeneratedApis,
} from "../src/be/scripts/typecheck";
import { createServer } from "../src/server";
import { SDK_ALLOWLIST, mcpToolNameForSdkMethod } from "../src/scripts-runtime/sdk-allowlist";

type RegisteredTools = Record<string, unknown>;

async function main() {
  process.env.DATABASE_PATH ??= "/tmp/agent-swarm-script-types.sqlite";
  // The SDK is derived from the full MCP registry regardless of deployment
  // CAPABILITIES — the scripts bridge is always full-surface, so the .d.ts
  // must be too (and generation must not depend on the local env's flags).
  const server = createServer({ fullSurface: true });
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
    `declare module "swarm-sdk" {\n${scriptSdkTypesWithGeneratedApis().replace(/^/gm, "  ")}\n}\n`,
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
