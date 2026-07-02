/** Fetch installed MCP servers from the API and return them as config-compatible entries */
export async function fetchInstalledMcpServers(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  format: "claude" | "opencode" = "claude",
): Promise<Record<string, Record<string, unknown>> | null> {
  try {
    const res = await fetch(`${apiUrl}/api/agents/${agentId}/mcp-servers?resolveSecrets=true`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
      },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      servers: Array<{
        name: string;
        transport: string;
        isActive: boolean;
        isEnabled: boolean;
        command?: string;
        args?: string;
        url?: string;
        headers?: string;
        resolvedEnv?: Record<string, string>;
        resolvedHeaders?: Record<string, string>;
      }>;
    };

    const entries: Record<string, Record<string, unknown>> = {};
    for (const srv of data.servers.filter((s) => s.isActive && s.isEnabled)) {
      if (srv.transport === "stdio" && srv.command) {
        let args: string[] = [];
        try {
          args = srv.args ? JSON.parse(srv.args) : [];
        } catch {
          // invalid JSON — use empty args
        }
        entries[srv.name] = {
          command: srv.command,
          args,
          env: srv.resolvedEnv || {},
        };
      } else if ((srv.transport === "http" || srv.transport === "sse") && srv.url) {
        let parsedHeaders: Record<string, string> = {};
        try {
          parsedHeaders = srv.headers ? JSON.parse(srv.headers) : {};
        } catch {
          // invalid JSON — use empty headers
        }
        if (format === "opencode") {
          entries[srv.name] = {
            type: "remote",
            url: srv.url,
            headers: { ...parsedHeaders, ...(srv.resolvedHeaders || {}) },
          };
        } else {
          entries[srv.name] = {
            type: srv.transport,
            url: srv.url,
            headers: { ...parsedHeaders, ...(srv.resolvedHeaders || {}) },
          };
        }
      }
    }
    return Object.keys(entries).length > 0 ? entries : null;
  } catch {
    return null;
  }
}
