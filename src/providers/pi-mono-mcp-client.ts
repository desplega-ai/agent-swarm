/**
 * Minimal MCP client for Streamable HTTP transport.
 *
 * Connects to the swarm's HTTP MCP endpoint, performs the handshake,
 * discovers tools, and forwards tool calls. This avoids depending on
 * a separate MCP client library for pi-mono.
 */

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agentId: string,
    private taskId?: string,
  ) {}

  private async send(body: unknown): Promise<{ data: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
      "X-Agent-ID": this.agentId,
    };
    if (this.taskId) {
      headers["X-Source-Task-Id"] = this.taskId;
    }
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`MCP request failed: ${res.status} ${res.statusText}`);
    }

    // Capture session ID from response
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    // Handle SSE responses (extract JSON from event stream)
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      const text = await res.text();
      const dataLines = text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
      const lastData = dataLines[dataLines.length - 1];
      return { data: lastData ? JSON.parse(lastData) : null, headers: res.headers };
    }

    const data = await res.json();
    return { data, headers: res.headers };
  }

  /** Perform MCP initialize + initialized handshake */
  async initialize(): Promise<void> {
    const { data } = await this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "agent-swarm-pi-mono", version: "1.0.0" },
      },
    });

    if (!data || typeof data !== "object" || !("result" in (data as Record<string, unknown>))) {
      throw new Error(`MCP initialize failed: ${JSON.stringify(data)}`);
    }

    // Send initialized notification (no response expected for notifications)
    await this.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  }

  /** Discover all available MCP tools */
  async listTools(): Promise<McpTool[]> {
    const { data } = await this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/list",
      params: {},
    });

    const result = data as { result?: { tools?: McpTool[] } };
    return result?.result?.tools ?? [];
  }

  /** Call an MCP tool */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const { data } = await this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    const result = data as { result?: McpToolCallResult };
    return result?.result ?? { content: [{ type: "text", text: "No result" }] };
  }
}
