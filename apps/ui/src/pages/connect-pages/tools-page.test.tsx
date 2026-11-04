import { describe, expect, test } from "bun:test";
import type { McpServer, OAuthAppSummary, ScriptConnection } from "../../api/types";
import { INTEGRATIONS } from "../../lib/integrations-catalog";
import { OAUTH_ONLY_TOOLS } from "../../lib/provider-status";
import {
  layoutToolCards,
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

const PRIMARY = defs(["github", "linear", "gmail"]);
const MORE = defs(["sentry", "agentfs", "serply"]);

describe("Tools tab cards", () => {
  test("in-use 'more' tools join the grid; the rest wait behind Show more", () => {
    const { shown, hidden } = layoutToolCards(PRIMARY, MORE, (def) => def.id === "agentfs", "");
    expect(shown.map((def) => def.id)).toEqual(["github", "linear", "gmail", "agentfs"]);
    expect(hidden.map((def) => def.id)).toEqual(["sentry", "serply"]);
  });

  test("a search shows every match, hidden or not", () => {
    const { shown, hidden } = layoutToolCards(PRIMARY, MORE, () => false, "sentry");
    expect(shown.map((def) => def.id)).toEqual(["sentry"]);
    expect(hidden).toEqual([]);
    expect(layoutToolCards(PRIMARY, MORE, () => false, "mail").shown.map((d) => d.id)).toEqual([
      "gmail",
    ]);
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
