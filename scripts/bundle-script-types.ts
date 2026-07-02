#!/usr/bin/env bun
import { closeDb } from "../apps/swarm/src/be/db";
import {
  SCRIPT_STDLIB_TYPES,
  scriptSdkTypesWithGeneratedApis,
} from "../apps/swarm/src/be/scripts/typecheck";
import { createServer } from "../apps/swarm/src/server";
import { SDK_ALLOWLIST, mcpToolNameForSdkMethod } from "../apps/swarm/src/scripts-runtime/sdk-allowlist";

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

  await Bun.$`mkdir -p apps/swarm/src/scripts-runtime/types`;
  await Bun.write(
    "apps/swarm/src/scripts-runtime/types/swarm-sdk.d.ts",
    `declare module "swarm-sdk" {\n${scriptSdkTypesWithGeneratedApis().replace(/^/gm, "  ")}\n}\n`,
  );
  await Bun.write("apps/swarm/src/scripts-runtime/types/stdlib.d.ts", SCRIPT_STDLIB_TYPES.trimStart());
  await Bun.$`bunx biome format --write apps/swarm/src/scripts-runtime/types/swarm-sdk.d.ts apps/swarm/src/scripts-runtime/types/stdlib.d.ts`;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
