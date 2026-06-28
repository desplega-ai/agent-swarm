import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "@swarm/api-server";
import { closeDb } from "@swarm/storage";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  await server.sendLoggingMessage({
    level: "info",
    data: "MCP server connected via stdio",
  });
}

main()
  .catch(console.error)
  .finally(() => {
    closeDb();
  });
