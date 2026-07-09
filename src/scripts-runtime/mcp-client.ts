import type { ScriptMcpConnectionDescriptor, ScriptMcpRegistryClient } from "./api-types";
import { Redacted } from "./redacted";
import type { SwarmConfig } from "./swarm-config";

function methodName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9]+(.)/g, (_m, chr: string) => chr.toUpperCase())
    .replace(/^[^A-Za-z_]+/, "")
    .replace(/[^A-Za-z0-9_]/g, "");
  if (!cleaned) throw new Error("MCP tool name must contain at least one letter");
  return `${cleaned[0]?.toLowerCase()}${cleaned.slice(1)}`;
}

function methodNames(
  tools: Array<{ name: string }>,
): Array<{ tool: { name: string }; methodName: string }> {
  const used = new Set<string>();
  const baseCounts = new Map<string, number>();
  return tools.map((tool) => {
    const base = methodName(tool.name);
    const count = baseCounts.get(base) ?? 0;
    baseCounts.set(base, count + 1);
    let toolMethod = count === 0 ? base : `${base}${count + 1}`;
    let suffix = count + 2;
    while (used.has(toolMethod)) {
      toolMethod = `${base}${suffix}`;
      suffix += 1;
    }
    used.add(toolMethod);
    return { tool, methodName: toolMethod };
  });
}

function headers(config: SwarmConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
    "X-Agent-ID": Redacted.value(config.agentId),
    "Content-Type": "application/json",
  };
}

function errorMessage(data: unknown): string {
  if (data && typeof data === "object") {
    if ("error" in data) return JSON.stringify((data as { error: unknown }).error);
    if ("message" in data) return String((data as { message: unknown }).message);
  }
  return "unknown MCP proxy error";
}

export function createMcpRegistryClient(
  descriptors: ScriptMcpConnectionDescriptor[] = [],
  config: SwarmConfig,
): ScriptMcpRegistryClient {
  const registry: ScriptMcpRegistryClient = {};
  const baseUrl = Redacted.value(config.mcpBaseUrl).replace(/\/$/, "");

  for (const descriptor of descriptors) {
    const client: ScriptMcpRegistryClient[string] = {};
    for (const { tool, methodName: toolMethod } of methodNames(descriptor.tools)) {
      client[toolMethod] = async (rawArgs = {}) => {
        const response = await fetch(
          `${baseUrl}/api/script-connections/${encodeURIComponent(descriptor.connectionId)}/mcp-call`,
          {
            method: "POST",
            headers: headers(config),
            body: JSON.stringify({ tool: tool.name, arguments: rawArgs ?? {} }),
          },
        );
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) {
          throw new Error(
            `ctx.mcp.${descriptor.slug}.${toolMethod} failed with ${response.status}: ${errorMessage(data)}`,
          );
        }
        if (!data || typeof data !== "object" || (data as { ok?: unknown }).ok !== true) {
          throw new Error(`ctx.mcp.${descriptor.slug}.${toolMethod} failed: ${errorMessage(data)}`);
        }
        return (data as { result: unknown }).result;
      };
    }
    registry[descriptor.slug] = client;
  }

  return registry;
}
