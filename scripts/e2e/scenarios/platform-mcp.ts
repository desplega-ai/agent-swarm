import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  cleanupStack,
  deleteConfig,
  expectToolError,
  expectToolOk,
  putConfig,
  registerAgent,
} from "./platform-helpers";

// Remote MCP server definitions (HTTP) with their install lifecycle and the MCP OAuth
// connection routes, then the same surface through the worker MCP tools and the script
// bridge. Server URLs are never contacted except the SUT's own loopback address, which the
// OAuth metadata probe refuses (private hosts are blocked unless explicitly allowed).

type Server = Record<string, unknown> & { id: string; name: string };

function serverOf(json: unknown): Server {
  return asRecord(asRecord(json).server) as Server;
}

export const platformMcpServers: Scenario = {
  name: "platform-mcp-servers",
  order: 640,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const remote = `https://mcp-${ctx.nonce}.example.com/mcp`;
    const tokenKey = `E2E_MCP_TOKEN_${ctx.nonce.toUpperCase()}`;
    try {
      // ── auth ───────────────────────────────────────────────────────────────
      for (const [method, path] of [
        ["GET", "/api/mcp-servers"],
        ["POST", "/api/mcp-servers"],
        ["GET", "/api/mcp-servers/x"],
        ["PUT", "/api/mcp-servers/x"],
        ["DELETE", "/api/mcp-servers/x"],
        ["POST", "/api/mcp-servers/x/install"],
        ["DELETE", "/api/mcp-servers/x/install/y"],
        ["GET", "/api/mcp-oauth/x/status"],
        ["GET", "/api/mcp-oauth/x/metadata"],
        ["GET", "/api/mcp-oauth/x/authorize-url"],
        ["GET", "/api/mcp-oauth/x/authorize"],
        ["POST", "/api/mcp-oauth/x/manual-client"],
        ["POST", "/api/mcp-oauth/x/refresh"],
        ["DELETE", "/api/mcp-oauth/x"],
      ] as const) {
        expectStatus(
          await ctx.api(method, path, {
            apiKey: null,
            body: method === "POST" || method === "PUT" ? {} : undefined,
          }),
          [401],
          `${method} ${path} unauth`,
        );
      }

      // ── create ─────────────────────────────────────────────────────────────
      const created = await ctx.api("POST", "/api/mcp-servers", {
        body: {
          name: `e2e-http-${ctx.nonce}`,
          description: "e2e http server",
          transport: "http",
          scope: "swarm",
          url: remote,
          headerConfigKeys: JSON.stringify({ Authorization: tokenKey }),
        },
      });
      expectStatus(created, [201], "create an http server");
      const http = serverOf(created.json);
      cleanup.add("delete the http server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${http.id}`);
      });
      expect(
        http.transport === "http" &&
          http.scope === "swarm" &&
          http.url === remote &&
          http.isEnabled === true &&
          http.version === 1 &&
          http.authMethod === "static" &&
          http.command === null,
        `a new http server has the documented defaults: ${JSON.stringify(http)}`,
      );
      const stdioCreated = await ctx.api("POST", "/api/mcp-servers", {
        body: {
          name: `e2e-stdio-${ctx.nonce}`,
          transport: "stdio",
          scope: "swarm",
          command: "echo",
          args: JSON.stringify(["hello"]),
        },
      });
      expectStatus(stdioCreated, [201], "create a stdio server");
      const stdio = serverOf(stdioCreated.json);
      cleanup.add("delete the stdio server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${stdio.id}`);
      });
      expect(stdio.command === "echo" && stdio.url === null, "a stdio server keeps its command");
      expect(
        ctx.db.get<{ name: string }>("SELECT name FROM mcp_servers WHERE id = ?", [http.id])
          ?.name === http.name,
        "the server is persisted",
      );

      const invalid: Array<[Record<string, unknown>, string]> = [
        [{ transport: "http", url: remote }, "no name"],
        [{ name: `e2e-x-${ctx.nonce}`, transport: "ftp" }, "an unknown transport"],
        [{ name: `e2e-x-${ctx.nonce}`, transport: "stdio" }, "stdio without a command"],
        [{ name: `e2e-x-${ctx.nonce}`, transport: "http" }, "http without a url"],
        [{ name: `e2e-x-${ctx.nonce}`, transport: "sse" }, "sse without a url"],
        [
          { name: `e2e-x-${ctx.nonce}`, transport: "http", url: "file:///etc/passwd" },
          "a non-http url",
        ],
        [
          { name: `e2e-http-${ctx.nonce}`, transport: "http", scope: "swarm", url: remote },
          "a duplicate name in the same scope",
        ],
      ];
      for (const [body, label] of invalid) {
        expectStatus(
          await ctx.api("POST", "/api/mcp-servers", { body }),
          [400],
          `create with ${label}`,
        );
      }

      // ── list, get, filters ─────────────────────────────────────────────────
      const listed = await ctx.api("GET", "/api/mcp-servers");
      expectStatus(listed, [200], "list servers");
      expect(
        asRecord(listed.json).total === asRecords(listed.json, "servers").length &&
          asRecords(listed.json, "servers").some((s) => s.id === http.id),
        "list returns servers and a matching total",
      );
      const ids = async (query: string) =>
        asRecords((await ctx.api("GET", `/api/mcp-servers?${query}`)).json, "servers").map(
          (s) => s.id,
        );
      expect(
        (await ids(`search=${ctx.nonce}&transport=stdio`)).join() === stdio.id,
        "the transport filter narrows the list",
      );
      expect(
        (await ids(`search=${ctx.nonce}&scope=swarm`)).length === 2,
        "the scope filter and search find both servers",
      );
      expect(
        (await ids(`search=${ctx.nonce}&scope=global`)).length === 0,
        "another scope finds nothing",
      );
      expect(
        (await ids(`search=${ctx.nonce}&enabled=false`)).length === 0,
        "no server is disabled yet",
      );
      const fetched = await ctx.api("GET", `/api/mcp-servers/${http.id}`);
      expectStatus(fetched, [200], "get a server");
      expect(
        asRecord(fetched.json).id === http.id && asRecord(fetched.json).url === remote,
        "get returns the server",
      );
      expectStatus(
        await ctx.api("GET", "/api/mcp-servers/no-such-server"),
        [404],
        "get an unknown server",
      );

      // ── update ─────────────────────────────────────────────────────────────
      const updated = await ctx.api("PUT", `/api/mcp-servers/${http.id}`, {
        body: { description: "updated", isEnabled: false },
      });
      expectStatus(updated, [200], "update a server");
      const afterUpdate = serverOf(updated.json);
      expect(
        afterUpdate.description === "updated" &&
          afterUpdate.isEnabled === false &&
          afterUpdate.version === 1,
        `a metadata-only update keeps the version: ${JSON.stringify(afterUpdate)}`,
      );
      expect(
        (await ids(`search=${ctx.nonce}&enabled=false`)).join() === http.id,
        "the enabled filter sees the disabled server",
      );
      expectStatus(
        await ctx.api("PUT", `/api/mcp-servers/${http.id}`, { body: { isEnabled: true } }),
        [200],
        "re-enable the server",
      );
      const moved = await ctx.api("PUT", `/api/mcp-servers/${http.id}`, {
        body: { url: `${remote}?v=2` },
      });
      expectStatus(moved, [200], "change the server url");
      expect(
        serverOf(moved.json).url === `${remote}?v=2` && serverOf(moved.json).version === 2,
        "a connection change bumps the version",
      );
      expectStatus(
        await ctx.api("PUT", `/api/mcp-servers/${http.id}`, { body: { url: remote } }),
        [200],
        "restore the server url",
      );
      expectStatus(
        await ctx.api("PUT", "/api/mcp-servers/no-such-server", { body: { description: "x" } }),
        [404],
        "update an unknown server",
      );
      expectStatus(
        await ctx.api("PUT", `/api/mcp-servers/${http.id}`, {
          body: { url: "file:///etc/passwd" },
        }),
        [400],
        "update to a non-http url",
      );
      expectStatus(
        await ctx.api("PUT", `/api/mcp-servers/${stdio.id}`, { body: { transport: "http" } }),
        [400],
        "switch stdio to http without a url",
      );

      // ── install and uninstall ──────────────────────────────────────────────
      const agentId = await registerAgent(ctx, "mcp-install");
      expectStatus(
        await ctx.api("POST", `/api/mcp-servers/${http.id}/install`, { body: {} }),
        [400],
        "install without an agentId",
      );
      expectStatus(
        await ctx.api("POST", "/api/mcp-servers/no-such-server/install", { body: { agentId } }),
        [404],
        "install an unknown server",
      );
      const installed = await ctx.api("POST", `/api/mcp-servers/${http.id}/install`, {
        body: { agentId },
      });
      expectStatus(installed, [200], "install a server for an agent");
      const link = asRecord(asRecord(installed.json).agentMcpServer);
      expect(
        link.agentId === agentId && link.mcpServerId === http.id,
        "install links the agent and the server",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM agent_mcp_servers WHERE agentId = ? AND mcpServerId = ?", [
          agentId,
          http.id,
        ]) !== null,
        "the install is persisted",
      );
      // The agent's server list resolves the header from config, never from the server row.
      const configRow = await putConfig(ctx, {
        key: tokenKey,
        value: `Bearer token-${ctx.nonce}`,
        isSecret: true,
      });
      cleanup.add("delete the header config", async () => deleteConfig(ctx, String(configRow.id)));
      const plainList = await ctx.api("GET", `/api/agents/${agentId}/mcp-servers`);
      expectStatus(plainList, [200], "agent server list");
      const plain = asRecords(plainList.json, "servers").find((s) => s.id === http.id);
      expect(
        plain && plain.resolvedHeaders === undefined,
        "the plain list carries no resolved secrets",
      );
      const resolvedList = await ctx.api(
        "GET",
        `/api/agents/${agentId}/mcp-servers?resolveSecrets=true`,
      );
      expectStatus(resolvedList, [200], "agent server list with secrets");
      const resolved = asRecords(resolvedList.json, "servers").find((s) => s.id === http.id);
      expect(
        asRecord(resolved?.resolvedHeaders).Authorization === `Bearer token-${ctx.nonce}`,
        "resolveSecrets maps headerConfigKeys to the stored config value",
      );
      const gone = await ctx.api("DELETE", `/api/mcp-servers/${http.id}/install/${agentId}`);
      expectStatus(gone, [200], "uninstall a server");
      expect(asRecord(gone.json).success === true, "uninstall reports success");
      expect(
        asRecord((await ctx.api("DELETE", `/api/mcp-servers/${http.id}/install/${agentId}`)).json)
          .success === false,
        "uninstalling twice reports false",
      );
      expect(
        asRecords(
          (await ctx.api("GET", `/api/agents/${agentId}/mcp-servers`)).json,
          "servers",
        ).every((s) => s.id !== http.id),
        "an uninstalled server leaves the agent's list",
      );

      // ── MCP OAuth connection routes ────────────────────────────────────────
      const status0 = await ctx.api("GET", `/api/mcp-oauth/${http.id}/status`);
      expectStatus(status0, [200], "oauth status before connecting");
      expect(
        asRecord(status0.json).mcpServerId === http.id &&
          asRecord(status0.json).authMethod === "static" &&
          asRecord(status0.json).connected === false &&
          asRecord(status0.json).token === null,
        "an unconnected server reports no token",
      );
      expectStatus(
        await ctx.api("GET", "/api/mcp-oauth/no-such-server/status"),
        [404],
        "oauth status of an unknown server",
      );
      expectStatus(
        await ctx.api("GET", `/api/mcp-oauth/${stdio.id}/metadata`),
        [400],
        "oauth metadata of a stdio server",
      );
      expectStatus(
        await ctx.api("GET", "/api/mcp-oauth/no-such-server/metadata"),
        [404],
        "oauth metadata of an unknown server",
      );
      expectStatus(
        await ctx.api("GET", `/api/mcp-oauth/${stdio.id}/authorize-url`),
        [400],
        "authorize-url of a stdio server",
      );
      expectStatus(
        await ctx.api("GET", "/api/mcp-oauth/no-such-server/authorize-url"),
        [404],
        "authorize-url of an unknown server",
      );
      expectStatus(
        await ctx.api("GET", "/api/mcp-oauth/no-such-server/authorize", { redirect: "manual" }),
        [404],
        "authorize of an unknown server",
      );
      expectStatus(
        await ctx.api("GET", `/api/mcp-oauth/${stdio.id}/authorize`, { redirect: "manual" }),
        [400],
        "authorize of a stdio server",
      );
      expectStatus(
        await ctx.api("POST", `/api/mcp-oauth/${stdio.id}/manual-client`, {
          body: { clientId: "x" },
        }),
        [400],
        "manual client for a stdio server",
      );
      expectStatus(
        await ctx.api("POST", "/api/mcp-oauth/no-such-server/manual-client", {
          body: { clientId: "x" },
        }),
        [404],
        "manual client for an unknown server",
      );
      expectStatus(
        await ctx.api("POST", `/api/mcp-oauth/${http.id}/manual-client`, {
          body: { clientId: "" },
        }),
        [400],
        "manual client with an empty clientId",
      );
      expectStatus(
        await ctx.api("POST", `/api/mcp-oauth/${http.id}/manual-client`, {
          body: {
            clientId: "x",
            authorizeUrl: "https://auth.example.com/a",
            tokenUrl: "https://auth.example.com/t",
          },
        }),
        [400],
        "manual endpoints without an issuer",
      );
      expectStatus(
        await ctx.api("POST", `/api/mcp-oauth/${http.id}/refresh`, { body: {} }),
        [404],
        "refresh with no token",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/mcp-oauth/${http.id}`),
        [404],
        "disconnect with no token",
      );

      // The metadata probe of the SUT's own loopback MCP endpoint is refused: private hosts
      // are blocked for OAuth discovery, and the route reports the probe failure.
      const loopback = await ctx.api("POST", "/api/mcp-servers", {
        body: {
          name: `e2e-self-${ctx.nonce}`,
          transport: "http",
          scope: "swarm",
          url: `${ctx.baseUrl}/mcp`,
        },
      });
      expectStatus(loopback, [201], "register the SUT itself as a remote server");
      const self = serverOf(loopback.json);
      cleanup.add("delete the loopback server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${self.id}`);
      });
      const probe = await ctx.api("GET", `/api/mcp-oauth/${self.id}/metadata`);
      // FINDING: the route documents 200/400/404 only, but a failed discovery answers 502.
      expectStatus(probe, [502], "oauth metadata of a loopback server");
      expect(
        String(asRecord(probe.json).error).startsWith("Metadata discovery failed"),
        "the 502 names the discovery failure",
      );

      // Pre-register a client (the DCR fallback) and walk the authorize flow up to the provider.
      const issuer = `https://auth-${ctx.nonce}.example.com`;
      const registered = await ctx.api("POST", `/api/mcp-oauth/${http.id}/manual-client`, {
        body: {
          clientId: `client-${ctx.nonce}`,
          clientSecret: `secret-${ctx.nonce}`,
          authorizationServerIssuer: issuer,
          authorizeUrl: `${issuer}/authorize`,
          tokenUrl: `${issuer}/token`,
          scopes: ["read", "write"],
        },
      });
      expectStatus(registered, [200], "register a manual client");
      expect(asRecord(registered.json).ok === true, "manual-client answers ok");
      const pendingStatus = asRecord(
        (await ctx.api("GET", `/api/mcp-oauth/${http.id}/status`)).json,
      );
      const pendingToken = asRecord(pendingStatus.token);
      expect(
        pendingStatus.connected === false &&
          pendingToken.status === "error" &&
          pendingToken.clientSource === "manual" &&
          pendingToken.hasRefreshToken === false &&
          pendingToken.authorizationServerIssuer === issuer &&
          pendingToken.resourceUrl === remote &&
          String(pendingToken.lastErrorMessage).includes("awaiting authorize flow"),
        `a registered client waits for the authorize flow: ${JSON.stringify(pendingToken)}`,
      );
      expect(
        !JSON.stringify(pendingStatus).includes(`secret-${ctx.nonce}`),
        "status never carries client credentials",
      );

      const after = "https://app.example.com/mcp-done";
      const authorizeUrl = await ctx.api(
        "GET",
        `/api/mcp-oauth/${http.id}/authorize-url?redirect=${encodeURIComponent(after)}&scopes=${encodeURIComponent("read write extra")}`,
      );
      expectStatus(authorizeUrl, [200], "build the authorize url");
      const provider = new URL(String(asRecord(authorizeUrl.json).providerUrl));
      const params = provider.searchParams;
      expect(
        `${provider.origin}${provider.pathname}` === `${issuer}/authorize` &&
          params.get("client_id") === `client-${ctx.nonce}` &&
          params.get("response_type") === "code" &&
          params.get("scope") === "read write extra" &&
          params.get("resource") === remote &&
          params.get("code_challenge_method") === "S256" &&
          (params.get("redirect_uri") ?? "").endsWith("/api/mcp-oauth/callback"),
        `the provider url carries client, scopes, resource and PKCE: ${provider}`,
      );
      const state = String(params.get("state"));
      const redirected = await ctx.api("GET", `/api/mcp-oauth/${http.id}/authorize`, {
        redirect: "manual",
      });
      expectStatus(redirected, [302], "authorize redirects");
      const redirectedTo = new URL(redirected.headers.get("location") ?? "http://invalid");
      expect(
        `${redirectedTo.origin}${redirectedTo.pathname}` === `${issuer}/authorize` &&
          redirectedTo.searchParams.get("state") !== state,
        "authorize redirects to the provider with a fresh state",
      );
      const pendingRows = ctx.db.query<{ state: string }>(
        "SELECT p.state FROM oauth_pending p JOIN oauth_apps a ON a.id = p.appId WHERE p.flow = 'mcp' AND a.mcpServerId = ?",
        [http.id],
      );
      expect(
        pendingRows.length >= 2 && pendingRows.some((r) => r.state === state),
        "each authorize call stores a pending state",
      );

      // ── callback ───────────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("GET", "/api/mcp-oauth/callback", { apiKey: null }),
        [400],
        "mcp callback without state",
      );
      expectStatus(
        await ctx.api("GET", "/api/mcp-oauth/callback?state=unknown&code=x", { apiKey: null }),
        [400],
        "mcp callback with an unknown state",
      );
      const denied = await ctx.api(
        "GET",
        `/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&error=access_denied&error_description=${encodeURIComponent("user said no")}`,
        { apiKey: null, redirect: "manual" },
      );
      expectStatus(denied, [302], "mcp callback after the user denied access");
      const deniedTarget = new URL(denied.headers.get("location") ?? "http://invalid");
      expect(
        `${deniedTarget.origin}${deniedTarget.pathname}` === after &&
          deniedTarget.searchParams.get("oauth") === "error" &&
          deniedTarget.searchParams.get("error") === "access_denied" &&
          deniedTarget.searchParams.get("error_description") === "user said no",
        "a denied callback redirects back with the error",
      );
      expectStatus(
        await ctx.api(
          "GET",
          `/api/mcp-oauth/callback?state=${encodeURIComponent(state)}&error=access_denied`,
          { apiKey: null },
        ),
        [400],
        "an mcp state is single use",
      );
      // The static callback also serves MCP flows: an unknown state is the same 400.
      expectStatus(
        await ctx.api("GET", "/api/oauth/callback?state=unknown&code=x", { apiKey: null }),
        [400],
        "static callback with an mcp-shaped unknown state",
      );

      // ── disconnect ─────────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("POST", `/api/mcp-oauth/${http.id}/refresh`, { body: {} }),
        [404],
        "refresh a token with no refresh token",
      );
      const disconnected = await ctx.api("DELETE", `/api/mcp-oauth/${http.id}`);
      expectStatus(disconnected, [200], "disconnect the server");
      expect(asRecord(disconnected.json).ok === true, "disconnect answers ok");
      const afterDisconnect = asRecord(
        (await ctx.api("GET", `/api/mcp-oauth/${http.id}/status`)).json,
      );
      expect(
        afterDisconnect.connected === false &&
          afterDisconnect.authMethod === "static" &&
          asRecord(afterDisconnect.token).status === "revoked" &&
          asRecord(afterDisconnect.token).hasRefreshToken === false,
        "disconnect keeps the row as revoked and returns the server to static auth",
      );
      // The row outlives a disconnect (revoked, not deleted), so a repeat disconnect still finds it.
      expectStatus(
        await ctx.api("DELETE", `/api/mcp-oauth/${http.id}`),
        [200],
        "disconnect a revoked connection again",
      );

      // ── delete ─────────────────────────────────────────────────────────────
      const deleted = await ctx.api("DELETE", `/api/mcp-servers/${stdio.id}`);
      expectStatus(deleted, [200], "delete a server");
      expect(
        asRecord(deleted.json).success === true &&
          asRecord(deleted.json).deletedScriptConnectionCount === 0,
        "delete reports success and the dropped script connections",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/mcp-servers/${stdio.id}`),
        [404],
        "delete a server twice",
      );
      expectStatus(
        await ctx.api("GET", `/api/mcp-servers/${stdio.id}`),
        [404],
        "get a deleted server",
      );
    } finally {
      await cleanup.run();
    }
  },
};

export const platformMcpServerTools: Scenario = {
  name: "platform-mcp-server-tools",
  order: 641,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const ownerId = await registerAgent(ctx, "mcp-owner");
    const otherId = await registerAgent(ctx, "mcp-other");
    const owner = await ctx.connectMcp(ownerId);
    const other = await ctx.connectMcp(otherId);
    const name = `e2e-tool-${ctx.nonce}`;
    const url = `https://tool-${ctx.nonce}.example.com/mcp`;
    try {
      // ── create ─────────────────────────────────────────────────────────────
      expectToolError(
        await callTool(owner, "mcp-server-create", { name, transport: "stdio" }),
        "create stdio without a command",
        "requires a command",
      );
      expectToolError(
        await callTool(owner, "mcp-server-create", { name, transport: "http" }),
        "create http without a url",
        "requires a url",
      );
      expectToolError(
        await callTool(owner, "mcp-server-create", {
          name,
          transport: "http",
          url,
          scope: "swarm",
        }),
        "create swarm scope as a worker",
        "Only lead agents",
      );
      expectToolError(
        await callTool(owner, "mcp-server-create", { name, transport: "stdio", command: "echo" }),
        "create an agent-scope stdio server as a worker",
        "Only lead agents",
      );
      expect(
        (await callTool(owner, "mcp-server-create", { name, transport: "websocket" })).isError,
        "create rejects an unknown transport",
      );

      const created = expectToolOk(
        await callTool(owner, "mcp-server-create", {
          name,
          description: "tool made",
          transport: "http",
          url,
        }),
        "create an agent-scope http server",
      );
      const server = asRecord(created.data.server);
      const serverId = String(server.id);
      cleanup.add("delete the tool server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${serverId}`);
      });
      expect(
        server.name === name &&
          server.scope === "agent" &&
          server.ownerAgentId === ownerId &&
          server.transport === "http",
        `an agent-scope server belongs to its creator: ${JSON.stringify(server)}`,
      );
      expect(created.message.includes(serverId), "the create message names the server id");
      expect(
        ctx.db.get("SELECT 1 AS one FROM agent_mcp_servers WHERE agentId = ? AND mcpServerId = ?", [
          ownerId,
          serverId,
        ]) !== null,
        "the creator is installed automatically",
      );
      expectToolError(
        await callTool(owner, "mcp-server-create", { name, transport: "http", url }),
        "create a duplicate",
        "UNIQUE",
      );

      // ── get and list ───────────────────────────────────────────────────────
      expectToolError(
        await callTool(owner, "mcp-server-get", {}),
        "get without id or name",
        "Provide id or name",
      );
      expectToolError(
        await callTool(owner, "mcp-server-get", { id: "no-such-server" }),
        "get an unknown id",
        "not found",
      );
      const byId = expectToolOk(
        await callTool(owner, "mcp-server-get", { id: serverId }),
        "get by id",
      );
      expect(asRecord(byId.data.server).id === serverId, "get by id returns the server");
      const byName = expectToolOk(await callTool(owner, "mcp-server-get", { name }), "get by name");
      expect(
        asRecord(byName.data.server).id === serverId,
        "get by name resolves the agent scope for the owner",
      );
      expectToolError(
        await callTool(other, "mcp-server-get", { name }),
        "get an agent-scope server by name from another agent",
        "not found",
      );

      const listed = expectToolOk(
        await callTool(owner, "mcp-server-list", { search: ctx.nonce }),
        "list",
      );
      expect(
        listed.data.total === 1 && (listed.data.servers as unknown[]).length === 1,
        "list filters by search",
      );
      expect(listed.text.includes(name), "the list text names the server");
      expect(
        expectToolOk(
          await callTool(owner, "mcp-server-list", { search: ctx.nonce, transport: "sse" }),
          "list sse",
        ).data.total === 0,
        "list filters by transport",
      );
      expect(
        expectToolOk(
          await callTool(owner, "mcp-server-list", { search: ctx.nonce, scope: "swarm" }),
          "list swarm",
        ).data.total === 0,
        "list filters by scope",
      );
      expect(
        expectToolOk(
          await callTool(owner, "mcp-server-list", { installedOnly: true }),
          "list installed",
        ).data.total === 1,
        "installedOnly lists the caller's servers",
      );
      expect(
        expectToolOk(
          await callTool(other, "mcp-server-list", { installedOnly: true }),
          "list installed for another agent",
        ).data.total === 0,
        "installedOnly hides other agents' installs",
      );

      // ── install and uninstall ──────────────────────────────────────────────
      expectToolError(
        await callTool(other, "mcp-server-install", { mcpServerId: serverId, agentId: ownerId }),
        "install for another agent as a worker",
        "Only leads",
      );
      expectToolError(
        await callTool(other, "mcp-server-install", { mcpServerId: "no-such-server" }),
        "install an unknown server",
        "not found",
      );
      expectToolOk(
        await callTool(other, "mcp-server-install", { mcpServerId: serverId }),
        "self-install",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM agent_mcp_servers WHERE agentId = ? AND mcpServerId = ?", [
          otherId,
          serverId,
        ]) !== null,
        "the self-install is persisted",
      );
      expectToolError(
        await callTool(other, "mcp-server-uninstall", { mcpServerId: serverId, agentId: ownerId }),
        "uninstall for another agent as a worker",
        "Only leads",
      );
      expectToolOk(
        await callTool(other, "mcp-server-uninstall", { mcpServerId: serverId }),
        "self-uninstall",
      );
      expectToolError(
        await callTool(other, "mcp-server-uninstall", { mcpServerId: serverId }),
        "uninstall twice",
        "was not installed",
      );

      // ── update ─────────────────────────────────────────────────────────────
      expectToolError(
        await callTool(owner, "mcp-server-update", { id: "no-such-server", description: "x" }),
        "update an unknown server",
        "not found",
      );
      expectToolError(
        await callTool(other, "mcp-server-update", { id: serverId, description: "hijack" }),
        "update by a non-owner",
        "owning agent or lead",
      );
      const updated = expectToolOk(
        await callTool(owner, "mcp-server-update", {
          id: serverId,
          description: "renamed by owner",
          isEnabled: false,
        }),
        "update by the owner",
      );
      expect(
        asRecord(updated.data.server).description === "renamed by owner" &&
          asRecord(updated.data.server).isEnabled === false &&
          asRecord(updated.data.server).version === 1,
        "update changes the fields",
      );
      expectToolError(
        await callTool(other, "mcp-server-install", { mcpServerId: serverId }),
        "install a disabled server",
        "disabled",
      );
      expectToolOk(
        await callTool(owner, "mcp-server-update", { id: serverId, isEnabled: true }),
        "re-enable",
      );

      // ── the script bridge reaches the same tools ───────────────────────────
      expectStatus(
        await ctx.api("POST", "/api/mcp-bridge", {
          apiKey: null,
          agentId: ownerId,
          body: { tool: "mcp-server-list", args: {} },
        }),
        [401],
        "bridge unauth",
      );
      const bridged = await ctx.api("POST", "/api/mcp-bridge", {
        agentId: ownerId,
        body: { tool: "mcp-server-list", args: { search: ctx.nonce } },
      });
      expectStatus(bridged, [200], "bridge a tool call");
      const bridgedBody = asRecord(bridged.json);
      expect(
        bridgedBody.success === true && bridgedBody.total === 1,
        "the bridge returns the tool's structured result",
      );
      const bridgedCreate = await ctx.api("POST", "/api/mcp-bridge", {
        agentId: ownerId,
        body: {
          tool: "mcp-server-create",
          args: { name: `${name}-bridged`, transport: "sse", url },
        },
      });
      expectStatus(bridgedCreate, [200], "bridge a write tool");
      const bridgedServer = asRecord(asRecord(bridgedCreate.json).server);
      expect(bridgedServer.ownerAgentId === ownerId, "a bridged write acts as the calling agent");
      cleanup.add("delete the bridged server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${String(bridgedServer.id)}`);
      });
      expectStatus(
        await ctx.api("POST", "/api/mcp-bridge", {
          agentId: ownerId,
          body: { tool: "mcp-server-list", args: { scope: "bogus" } },
        }),
        [400],
        "bridge with invalid args",
      );
      expectStatus(
        await ctx.api("POST", "/api/mcp-bridge", {
          agentId: ownerId,
          body: { tool: "", args: {} },
        }),
        [400],
        "bridge without a tool name",
      );
      expectStatus(
        await ctx.api("POST", "/api/mcp-bridge", {
          agentId: ownerId,
          body: { tool: "no-such-tool", args: {} },
        }),
        [403],
        "bridge an unknown tool",
      );
      expectStatus(
        await ctx.api("POST", "/api/mcp-bridge", {
          agentId: ownerId,
          body: { tool: "register-kapso-number", args: { phoneNumberId: "1" } },
        }),
        [403],
        "bridge a tool outside the script allowlist",
      );
      const anonymous = await ctx.api("POST", "/api/mcp-bridge", {
        body: { tool: "get-config", args: {} },
      });
      expectStatus(anonymous, [200], "bridge without an agent id");
      expect(
        asRecord(anonymous.json).success === false,
        "a tool-level failure is returned in the 200 body",
      );

      // ── delete ─────────────────────────────────────────────────────────────
      expectToolError(
        await callTool(other, "mcp-server-delete", { id: serverId }),
        "delete by a non-owner",
        "owning agent or lead",
      );
      expectToolError(
        await callTool(owner, "mcp-server-delete", { id: "no-such-server" }),
        "delete an unknown server",
        "not found",
      );
      const deleted = expectToolOk(
        await callTool(owner, "mcp-server-delete", { id: serverId }),
        "delete by the owner",
      );
      expect(deleted.message.includes(name), "the delete message names the server");
      expect(
        ctx.db.get("SELECT 1 AS one FROM mcp_servers WHERE id = ?", [serverId]) === null,
        "the server row is gone",
      );
      expect(
        ctx.db.get("SELECT 1 AS one FROM agent_mcp_servers WHERE mcpServerId = ?", [serverId]) ===
          null,
        "deleting a server drops its installs",
      );
    } finally {
      await owner.close();
      await other.close();
      await cleanup.run();
    }
  },
};
