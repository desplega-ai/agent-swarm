/**
 * Minimal MCP client for Streamable HTTP transport.
 *
 * Performs the initialize handshake, tracks MCP session IDs, parses JSON/SSE
 * responses, discovers tools, and forwards tool calls. The client itself is
 * transport-only: callers provide any auth headers and it never imports DB code.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export type McpJsonRpcError = {
  code?: number;
  message?: string;
  data?: unknown;
};

export type McpToolCallEnvelope =
  | { ok: true; result: McpToolCallResult }
  | { ok: false; error: McpJsonRpcError | string };

function jsonRpcErrorMessage(error: McpJsonRpcError | string): string {
  if (typeof error === "string") return error;
  return error.message ?? JSON.stringify(error);
}

type McpHttpClientOptions = {
  protocolVersion?: string;
  clientInfo?: { name: string; version: string };
  timeoutMs?: number;
  omitEmptyAuthHeaders?: boolean;
};

export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  /** Additional headers merged into every request (e.g. for installed MCP servers) */
  public customHeaders: Record<string, string> = {};
  /**
   * When true, baseUrl is used as-is for requests (external MCP servers).
   * When false (default), /mcp is appended (swarm convention).
   */
  public useRawUrl = false;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private agentId: string,
    private taskId?: string,
    private options: McpHttpClientOptions = {},
  ) {}

  private async send(body: unknown): Promise<{ data: unknown; headers: Headers }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.apiKey || !this.options.omitEmptyAuthHeaders) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (this.agentId || !this.options.omitEmptyAuthHeaders) {
      headers["X-Agent-ID"] = this.agentId;
    }
    Object.assign(headers, this.customHeaders);
    if (this.taskId) {
      headers["X-Source-Task-Id"] = this.taskId;
    }
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    const controller = this.options.timeoutMs ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.options.timeoutMs)
      : null;
    const url = this.useRawUrl ? this.baseUrl : `${this.baseUrl}/mcp`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller?.signal,
      });

      if (!res.ok) {
        throw new Error(`MCP request failed: ${res.status} ${res.statusText}`);
      }

      // Capture session ID from response.
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;

      // Handle SSE responses (extract JSON from event stream).
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        const text = await res.text();
        const dataLines = text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6));
        const lastData = dataLines[dataLines.length - 1];
        return { data: lastData ? JSON.parse(lastData) : null, headers: res.headers };
      }

      const text = await res.text();
      const data = text.trim() ? JSON.parse(text) : null;
      return { data, headers: res.headers };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`MCP request timed out after ${this.options.timeoutMs}ms`);
      }
      throw err;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** Perform MCP initialize + initialized handshake */
  async initialize(): Promise<void> {
    const { data } = await this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: this.options.protocolVersion ?? "2025-03-26",
        capabilities: {},
        clientInfo: this.options.clientInfo ?? {
          name: "agent-swarm-pi-mono",
          version: "1.0.0",
        },
      },
    });

    if (!data || typeof data !== "object" || !("result" in (data as Record<string, unknown>))) {
      throw new Error(`MCP initialize failed: ${JSON.stringify(data)}`);
    }

    // Send initialized notification (no response expected for notifications).
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

    const result = data as { result?: { tools?: McpTool[] }; error?: McpJsonRpcError | string };
    if (result?.error) {
      throw new Error(`MCP tools/list failed: ${jsonRpcErrorMessage(result.error)}`);
    }
    return result?.result?.tools ?? [];
  }

  /** Call an MCP tool and preserve either the JSON-RPC result or error shape. */
  async callToolRaw(name: string, args: Record<string, unknown>): Promise<McpToolCallEnvelope> {
    const { data } = await this.send({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    const response = data as {
      result?: McpToolCallResult;
      error?: McpJsonRpcError | string;
    };
    if (response?.error) return { ok: false, error: response.error };
    return {
      ok: true,
      result: response?.result ?? { content: [{ type: "text", text: "No result" }] },
    };
  }

  /** Call an MCP tool */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const envelope = await this.callToolRaw(name, args);
    return envelope.ok ? envelope.result : { content: [{ type: "text", text: "No result" }] };
  }
}
