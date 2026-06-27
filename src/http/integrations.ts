import type { IncomingMessage, ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { getResolvedConfig } from "@swarm/storage";
import { z } from "zod";
import { route } from "./route-def";
import { json } from "./utils";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal `client.beta.agents.retrieve` shape we depend on. Lets tests inject
 * a fake without pulling the entire SDK surface in.
 */
export interface ClaudeManagedTestClient {
  beta: {
    agents: {
      retrieve: (agentId: string) => Promise<{ name?: string | null; model?: string | null }>;
    };
  };
}

interface TestConnectionDeps {
  /**
   * Optional injectable client factory. When omitted, a real `Anthropic` SDK
   * client is constructed with the resolved API key.
   */
  buildClient?: (apiKey: string) => ClaudeManagedTestClient;
}

// ─── Route Definition ────────────────────────────────────────────────────────

const claudeManagedTestRoute = route({
  method: "post",
  path: "/api/integrations/claude-managed/test",
  pattern: ["api", "integrations", "claude-managed", "test"],
  summary:
    "Test the claude-managed integration: resolves ANTHROPIC_API_KEY + MANAGED_AGENT_ID from swarm_config and calls beta.agents.retrieve.",
  tags: ["Integrations"],
  body: z.object({}).optional(),
  responses: {
    200: {
      description:
        "Connection result — `{ ok: true, agentName, model }` on success or `{ ok: false, error }` on any failure (missing config, Anthropic API error). Always 200 OK.",
    },
  },
});

const mcpUserConfigRoute = route({
  method: "get",
  path: "/api/integrations/mcp-user/config",
  pattern: ["api", "integrations", "mcp-user", "config"],
  summary: "Get server-derived config for end-user MCP clients.",
  tags: ["Integrations"],
  responses: {
    200: {
      description:
        "Server-derived MCP user config. `mcpBaseUrl` is the API server base URL and `mcpUserUrl` appends `/mcp-user`.",
    },
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Look up a config value by key. Falls back to `process.env` when no
 * swarm_config row exists — mirrors the resolution order used elsewhere
 * (see `loadGlobalConfigsIntoEnv`).
 *
 * Returns the trimmed value or `null` if unset/empty.
 */
function resolveConfigValue(key: string): string | null {
  const configs = getResolvedConfig();
  // The setup CLI persists keys in lowercase (e.g. `managed_agent_id`) while
  // the docker-entrypoint hydrates env vars in uppercase (`MANAGED_AGENT_ID`).
  // Look up both variants so this endpoint works against either shape.
  const variants = [key, key.toLowerCase(), key.toUpperCase()];
  for (const variant of variants) {
    const row = configs.find((c) => c.key === variant);
    if (row && typeof row.value === "string" && row.value.length > 0) {
      return row.value;
    }
  }
  // Env fallback — the row may not exist if the operator deployed via env
  // file rather than swarm_config.
  const envValue = process.env[key];
  if (envValue && envValue.length > 0) return envValue;
  return null;
}

function resolveMcpBaseUrl(): string {
  // Browser-facing connect URLs: prefer the public ingress origin
  // (PUBLIC_MCP_BASE_URL) over the internal MCP_BASE_URL so split deployments
  // (Helm) surface a host the user's browser can actually reach. Both honor the
  // swarm_config → env resolution order. Falls back to the localhost dev base.
  const configured =
    resolveConfigValue("PUBLIC_MCP_BASE_URL") ?? resolveConfigValue("MCP_BASE_URL");
  const fallback = `http://localhost:${process.env.PORT || "3013"}`;
  return (configured || fallback).replace(/\/+$/, "");
}

// ─── Public handler factory ──────────────────────────────────────────────────

/**
 * Build the integrations handler. Exposed as a factory so tests can inject a
 * fake Anthropic client.
 */
export function createIntegrationsHandler(deps: TestConnectionDeps = {}) {
  const buildClient =
    deps.buildClient ??
    ((apiKey: string) => new Anthropic({ apiKey }) as unknown as ClaudeManagedTestClient);

  return async function handleIntegrations(
    req: IncomingMessage,
    res: ServerResponse,
    pathSegments: string[],
  ): Promise<boolean> {
    if (mcpUserConfigRoute.match(req.method, pathSegments)) {
      const mcpBaseUrl = resolveMcpBaseUrl();
      json(res, { mcpBaseUrl, mcpUserUrl: `${mcpBaseUrl}/mcp-user` });
      return true;
    }

    if (claudeManagedTestRoute.match(req.method, pathSegments)) {
      const apiKey = resolveConfigValue("ANTHROPIC_API_KEY");
      const agentId = resolveConfigValue("MANAGED_AGENT_ID");

      if (!apiKey || !agentId) {
        const missing: string[] = [];
        if (!apiKey) missing.push("ANTHROPIC_API_KEY");
        if (!agentId) missing.push("MANAGED_AGENT_ID");
        json(res, {
          ok: false,
          error: `Missing required config: ${missing.join(", ")}. Run \`bun run src/cli.tsx claude-managed-setup\` to populate.`,
        });
        return true;
      }

      try {
        const client = buildClient(apiKey);
        const agent = await client.beta.agents.retrieve(agentId);
        // `agent.model` is `BetaManagedAgentsModelConfig` ({id, speed}). Flatten
        // to a string so the UI can render it directly without type guards.
        const modelId =
          typeof agent.model === "string"
            ? agent.model
            : ((agent.model as { id?: string } | null | undefined)?.id ?? null);
        json(res, {
          ok: true,
          agentName: agent.name ?? null,
          model: modelId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, { ok: false, error: message });
      }
      return true;
    }

    return false;
  };
}

// ─── Default singleton (used in production / OpenAPI generation) ─────────────

export const handleIntegrations = createIntegrationsHandler();
