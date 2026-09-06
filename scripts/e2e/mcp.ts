import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const calledToolNames = new Set<string>();
const listedToolNames = new Set<string>();

export function calledMcpTools(): ReadonlySet<string> {
  return calledToolNames;
}

export function listedMcpTools(): ReadonlySet<string> {
  return listedToolNames;
}

export type McpConnection = Awaited<ReturnType<ReturnType<typeof createMcpConnector>>>;

export function createMcpConnector(baseUrl: string, key: string) {
  return async function connectMcp(agentId: string) {
    const client = new Client({ name: "agent-swarm-e2e", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${key}`,
          "X-Agent-ID": agentId,
        },
      },
    });
    await client.connect(transport);

    return {
      async listTools() {
        const result = await client.listTools();
        for (const tool of result.tools) listedToolNames.add(tool.name);
        return result.tools;
      },
      async callTool(name: string, args: Record<string, unknown>) {
        calledToolNames.add(name);
        return client.callTool({ name, arguments: args });
      },
      async close() {
        await client.close();
      },
    };
  };
}
