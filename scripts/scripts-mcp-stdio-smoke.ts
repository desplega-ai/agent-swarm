#!/usr/bin/env bun
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SCRIPT_DELETE_DESCRIPTION } from "../src/tools/script-delete";
import { SCRIPT_QUERY_TYPES_DESCRIPTION } from "../src/tools/script-query-types";
import { SCRIPT_RUN_DESCRIPTION } from "../src/tools/script-run";
import { SCRIPT_SEARCH_DESCRIPTION } from "../src/tools/script-search";
import { SCRIPT_UPSERT_DESCRIPTION } from "../src/tools/script-upsert";

const expected = new Map([
  ["script-search", SCRIPT_SEARCH_DESCRIPTION],
  ["script-run", SCRIPT_RUN_DESCRIPTION],
  ["script-upsert", SCRIPT_UPSERT_DESCRIPTION],
  ["script-delete", SCRIPT_DELETE_DESCRIPTION],
  ["script-query-types", SCRIPT_QUERY_TYPES_DESCRIPTION],
]);

const dbPath = `/tmp/agent-swarm-mcp-stdio-smoke-${process.pid}.sqlite`;
const transport = new StdioClientTransport({
  command: "bun",
  args: ["src/stdio.ts"],
  env: {
    ...process.env,
    DATABASE_PATH: dbPath,
    AGENT_SWARM_API_KEY: process.env.AGENT_SWARM_API_KEY ?? process.env.API_KEY ?? "123123",
  },
});

const client = new Client({ name: "script-mcp-stdio-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const result = await client.listTools();
  const tools = new Map(result.tools.map((tool) => [tool.name, tool.description ?? ""]));

  for (const [name, description] of expected) {
    if (tools.get(name) !== description) {
      throw new Error(`Missing or mismatched ${name} description`);
    }
  }

  console.log(`PASS script MCP stdio smoke: found ${expected.size} script tools`);
} finally {
  await client.close();
  await Bun.$`rm -f ${dbPath} ${dbPath}-wal ${dbPath}-shm`;
}
