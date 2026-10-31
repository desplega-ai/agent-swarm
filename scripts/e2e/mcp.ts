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

export type McpConnectOptions = {
  /** Extra request headers, such as `X-Source-Task-ID` for task-scoped tools. */
  headers?: Record<string, string>;
  /** Bearer to send instead of the run's operator key (a user `aswt_` token, a run token). */
  apiKey?: string;
  /** Endpoint path, default `/mcp`. `/mcp-user` for user-token sessions. */
  path?: string;
};

export function createMcpConnector(baseUrl: string, key: string) {
  return async function connectMcp(agentId: string, options: McpConnectOptions = {}) {
    const client = new Client({ name: "agent-swarm-e2e", version: "1.0.0" });
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${options.apiKey ?? key}`);
    headers.set("X-Agent-ID", agentId);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl}${options.path ?? "/mcp"}`),
      {
        requestInit: {
          headers,
        },
      },
    );
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
