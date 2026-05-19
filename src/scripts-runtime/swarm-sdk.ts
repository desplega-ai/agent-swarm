import { scrubObject } from "../utils/secret-scrubber";
import { Redacted } from "./redacted";
import { isSdkToolAllowed } from "./sdk-allowlist";
import type { SwarmConfig } from "./swarm-config";

function headers(config: SwarmConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${Redacted.value(config.apiKey)}`,
    "X-Agent-ID": Redacted.value(config.agentId),
    "Content-Type": "application/json",
  };
}

async function callScriptsApi(name: string, args: unknown, config: SwarmConfig): Promise<unknown> {
  const baseUrl = Redacted.value(config.mcpBaseUrl).replace(/\/$/, "");
  const body = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const method = "POST";
  let path = "";

  switch (name) {
    case "script_search":
      path = "/api/scripts/search";
      break;
    case "script_run":
      path = "/api/scripts/run";
      break;
    default:
      throw new Error(`Tool '${name}' is not exposed through the scripts SDK bridge`);
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(config),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `scripts api failed with ${res.status}`;
    throw new Error(`swarm-sdk: ${name} failed with ${res.status}: ${message}`);
  }
  return scrubObject({ success: true, status: res.status, data });
}

async function callTool(name: string, args: unknown, config: SwarmConfig): Promise<unknown> {
  if (!isSdkToolAllowed(name)) {
    throw new Error(
      `Tool '${name}' is not exposed to scripts (lifecycle/cred tool); use the MCP surface directly if you're an agent`,
    );
  }

  if (name === "script_search" || name === "script_run") {
    return callScriptsApi(name, args, config);
  }

  throw new Error(
    `Tool '${name}' is declared in the script SDK types but is not available from the scripts HTTP bridge yet`,
  );
}

export function createSwarmSdk(
  config: SwarmConfig,
): Record<string, (args?: unknown) => Promise<unknown>> {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in target) return target[prop];
      return (args?: unknown) => callTool(prop, args, config);
    },
  }) as Record<string, (args?: unknown) => Promise<unknown>>;
}
