import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb } from "../be/db";
import { createServer } from "../server";

const TEST_DB_PATH = "./test-mcp-tools.sqlite";

type RegisteredTool = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

describe("script_ MCP tools", () => {
  let tools: Record<string, RegisteredTool>;
  let savedDatabasePath: string | undefined;

  beforeAll(async () => {
    savedDatabasePath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = TEST_DB_PATH;
    await removeDbFiles(TEST_DB_PATH);
    const server = createServer();
    tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
  });

  afterAll(async () => {
    closeDb();
    if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = savedDatabasePath;
    await removeDbFiles(TEST_DB_PATH);
  });

  test("registers all script_ tools with schemas and documented descriptions", () => {
    const expected = {
      script_search:
        "Semantic search over swarm-shared TypeScript scripts (catalog persisted in the agent-swarm DB; callable from agents and workflows). For ephemeral throwaway TS on your local machine, use code-mode instead.",
      script_run:
        "Run a named swarm-shared script (callable across agents and from workflow `swarm-script` nodes), OR inline source (auto-saved as scratch to the catalog). Use for swarm-visible, durable scripts. For local-only throwaway TS, use code-mode `run`.",
      script_upsert:
        "Persist a TypeScript script to the swarm catalog under your agent scope (or global if you're a lead). Other agents and workflow nodes will be able to find and run it. For local-only scripts, use code-mode `save`.",
      script_delete:
        "Remove a swarm-shared script from the catalog. Versions table preserves history.",
      script_query_types:
        "Fetch the signature + the auto-generated `swarm-sdk.d.ts` (derived from the live MCP tool registry) + the `stdlib.d.ts` blobs — for IDE-style introspection before authoring or running a script. The same types are used by `script_upsert`'s typecheck pass, so they are authoritative.",
    };

    for (const [name, description] of Object.entries(expected)) {
      expect(tools[name]).toBeDefined();
      expect(tools[name].title).toBeTruthy();
      expect(tools[name].description).toBe(description);
      expect(tools[name].inputSchema).toBeTruthy();
      expect(tools[name].outputSchema).toBeTruthy();
      expect(tools[name].annotations).toBeTruthy();
    }
  });
});
