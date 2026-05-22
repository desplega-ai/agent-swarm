export interface McpSnippetInput {
  serverUrl: string;
  token: string;
}

export interface McpClientSnippet {
  id: string;
  label: string;
  description: string;
  language: "bash" | "json";
  value: string;
}

function authHeader(token: string): string {
  return `Bearer ${token}`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function buildMcpClientSnippets({ serverUrl, token }: McpSnippetInput): McpClientSnippet[] {
  const authorization = authHeader(token);
  return [
    {
      id: "claude-code",
      label: "Claude Code CLI",
      description: "Adds this user's hosted MCP endpoint as a user-scoped HTTP server.",
      language: "bash",
      value: `claude mcp add --transport http agent-swarm-user ${serverUrl} --scope user --header "Authorization: ${authorization}"`,
    },
    {
      id: "cursor",
      label: "Cursor",
      description: "Paste into .cursor/mcp.json or the user-level Cursor MCP config.",
      language: "json",
      value: json({
        mcpServers: {
          "agent-swarm-user": {
            type: "http",
            url: serverUrl,
            headers: {
              Authorization: authorization,
            },
          },
        },
      }),
    },
    {
      id: "vscode",
      label: "VS Code / Copilot",
      description: "Paste into .vscode/mcp.json or the user MCP configuration.",
      language: "json",
      value: json({
        servers: {
          "agent-swarm-user": {
            type: "http",
            url: serverUrl,
            headers: {
              Authorization: authorization,
            },
          },
        },
      }),
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop via mcp-remote",
      description: "Uses a local bridge so the bearer header can be attached to remote HTTP.",
      language: "json",
      value: json({
        mcpServers: {
          "agent-swarm-user": {
            command: "npx",
            args: ["-y", "mcp-remote", serverUrl, "--header", `Authorization: ${authorization}`],
          },
        },
      }),
    },
    {
      id: "generic-mcp-remote",
      label: "Generic mcp-remote bridge",
      description:
        "Use for clients that launch stdio MCP commands such as Windsurf, Zed, Cline, Goose, or JetBrains.",
      language: "json",
      value: json({
        command: "npx",
        args: ["-y", "mcp-remote", serverUrl, "--header", `Authorization: ${authorization}`],
      }),
    },
    {
      id: "curl",
      label: "curl debug",
      description: "Quick JSON-RPC initialize check against the hosted user MCP route.",
      language: "bash",
      value: `curl -s ${serverUrl} \\
  -H "Authorization: ${authorization}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"debug"}}}'`,
    },
  ];
}
