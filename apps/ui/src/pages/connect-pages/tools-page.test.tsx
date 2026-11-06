import { describe, expect, test } from "bun:test";
import type { McpServer, OAuthAppSummary, ScriptConnection } from "../../api/types";
import { INTEGRATIONS } from "../../lib/integrations-catalog";
import { OAUTH_ONLY_TOOLS } from "../../lib/provider-status";
import {
  filterToolGroups,
  matchMcpServer,
  matchOAuthApp,
  matchScriptConnection,
} from "../../lib/tools-search";

// The page itself mounts DataGrid and every aliased hook; its tab search runs
// through these pure filters, so the tests cover them directly.

const defs = (ids: string[]) =>
  ids.map((id) => {
    const def = [...INTEGRATIONS, ...OAUTH_ONLY_TOOLS].find((candidate) => candidate.id === id);
    if (!def) throw new Error(`Missing tool: ${id}`);
    return def;
  });

const GROUPS = [
  { title: "Code and issues", tools: defs(["github", "linear"]) },
  { title: "Email", tools: defs(["gmail"]) },
  { title: "Monitoring", tools: defs(["sentry"]) },
];

describe("Tools tab groups", () => {
  test("no search shows every group and every tool", () => {
    expect(filterToolGroups(GROUPS, "")).toEqual(GROUPS);
  });

  test("a search keeps the matches and drops empty groups", () => {
    const shown = filterToolGroups(GROUPS, "mail");
    expect(shown.map((group) => group.title)).toEqual(["Email"]);
    expect(shown[0]?.tools.map((def) => def.id)).toEqual(["gmail"]);
    expect(filterToolGroups(GROUPS, "nothing-matches")).toEqual([]);
  });
});

describe("tab search", () => {
  test("Script connections match slug, name and base URL", () => {
    const connection = {
      slug: "tickets",
      displayName: "Acme tickets",
      kind: "openapi",
      baseUrl: "https://acme.atlassian.net",
      mcpServerId: null,
    } as ScriptConnection;
    expect(matchScriptConnection(connection, "atlassian")).toBe(true);
    expect(matchScriptConnection(connection, "ACME tick")).toBe(true);
    expect(matchScriptConnection(connection, "github")).toBe(false);
    expect(matchScriptConnection(connection, "")).toBe(true);
  });

  test("OAuth apps match provider, client ID and account emails", () => {
    const app = {
      provider: "google",
      clientId: "client-123",
      source: "curated-prefill",
      authorizations: [{ label: "default", accountEmail: "ops@acme.dev" }],
    } as OAuthAppSummary;
    expect(matchOAuthApp(app, "google")).toBe(true);
    expect(matchOAuthApp(app, "client-123")).toBe(true);
    expect(matchOAuthApp(app, "ops@acme")).toBe(true);
    expect(matchOAuthApp(app, "microsoft")).toBe(false);
  });

  test("MCP servers match name, transport and URL", () => {
    const server = {
      name: "context7",
      description: "Library docs",
      transport: "http",
      scope: "swarm",
      url: "https://mcp.context7.com/mcp",
      command: null,
    } as McpServer;
    expect(matchMcpServer(server, "context7")).toBe(true);
    expect(matchMcpServer(server, "http docs")).toBe(true);
    expect(matchMcpServer(server, "playwright")).toBe(false);
  });
});
