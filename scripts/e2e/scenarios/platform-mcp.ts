import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  cleanupStack,
  deleteConfig,
  expectToolError,
  expectToolOk,
  jsonResponse,
  type MockRequest,
  putConfig,
  registerAgent,
  startMockServer,
} from "./platform-helpers";

// Remote MCP server definitions (HTTP) with their install lifecycle and the MCP OAuth
// connection routes, then the same surface through the worker MCP tools and the script
// bridge. Server URLs are never contacted except a loopback authorization server the
// scenario runs: the SUT boots with MCP_OAUTH_ALLOW_PRIVATE_HOSTS=true, so discovery,
// dynamic client registration, code exchange, refresh and revocation all reach it.

type Server = Record<string, unknown> & { id: string; name: string };

function serverOf(json: unknown): Server {
  return asRecord(asRecord(json).server) as Server;
}

type AuthorizationServer = ReturnType<typeof startAuthorizationServer>;

/**
 * A loopback MCP resource and authorization server in one origin: protected-resource and
 * authorization-server metadata, dynamic client registration, the token endpoint (code
 * exchange and refresh) and revocation. `state` scripts its failures.
 */
function startAuthorizationServer() {
  const state = {
    /** "down" makes the authorization-server metadata answer 503. */
    metadata: "ok" as "ok" | "down",
    /** How the next refresh grants answer. */
    refresh: "ok" as "ok" | "server_error" | "invalid_client",
    registered: 0,
    issued: 0,
  };
  const server = startMockServer((request: MockRequest) => {
    if (request.path === "/.well-known/oauth-protected-resource") {
      return jsonResponse({
        resource: `${server.origin}/mcp`,
        authorization_servers: [server.origin],
        scopes_supported: ["read", "write"],
        bearer_methods_supported: ["header"],
      });
    }
    if (request.path === "/.well-known/oauth-authorization-server") {
      if (state.metadata === "down") return new Response("metadata down", { status: 503 });
      return jsonResponse({
        issuer: server.origin,
        authorization_endpoint: `${server.origin}/authorize`,
        token_endpoint: `${server.origin}/token`,
        registration_endpoint: `${server.origin}/register`,
        revocation_endpoint: `${server.origin}/revoke`,
        scopes_supported: ["read", "write"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      });
    }
    if (request.path === "/register") {
      state.registered += 1;
      return jsonResponse(
        {
          client_id: `dcr-${state.registered}`,
          client_secret: `dcr-secret-${state.registered}`,
          token_endpoint_auth_method: "client_secret_basic",
        },
        201,
      );
    }
    if (request.path === "/token") {
      const grant = request.form.get("grant_type");
      if (grant === "authorization_code") {
        if (request.form.get("code") === "bad")
          return jsonResponse({ error: "invalid_grant" }, 400);
        state.issued += 1;
        return jsonResponse({
          access_token: `at-${state.issued}`,
          refresh_token: `rt-${state.issued}`,
          expires_in: 3600,
          token_type: "bearer",
          scope: "read write",
        });
      }
      if (grant === "refresh_token") {
        if (state.refresh === "server_error") return new Response("token down", { status: 500 });
        if (state.refresh === "invalid_client") {
          return jsonResponse({ error: "invalid_client" }, 401);
        }
        state.issued += 1;
        return jsonResponse({
          access_token: `at-${state.issued}`,
          refresh_token: `rt-${state.issued}`,
          expires_in: 3600,
          token_type: "bearer",
        });
      }
      return jsonResponse({ error: "unsupported_grant_type" }, 400);
    }
    if (request.path === "/revoke") return jsonResponse({});
    return new Response("not found", { status: 404 });
  });
  return Object.assign(server, { state });
}

function tokenRequests(as: AuthorizationServer, grant: string): MockRequest[] {
  return as.requests.filter((r) => r.path === "/token" && r.form.get("grant_type") === grant);
}

/** `client_id:client_secret` out of a Basic Authorization header, or null. */
function basicCredentials(request: MockRequest | undefined): string | null {
  const header = request?.headers.get("authorization") ?? "";
  return header.startsWith("Basic ")
    ? Buffer.from(header.slice("Basic ".length), "base64").toString()
    : null;
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
      ];
      for (const [body, label] of invalid) {
        expectStatus(
          await ctx.api("POST", "/api/mcp-servers", { body }),
          [400],
          `create with ${label}`,
        );
      }
      // A duplicate name in the same scope answers 409 mcp_server_name_taken, never SQLite text.
      const duplicateName = await ctx.api("POST", "/api/mcp-servers", {
        body: { name: `e2e-http-${ctx.nonce}`, transport: "http", scope: "swarm", url: remote },
      });
      expectStatus(duplicateName, [409], "create with a duplicate name in the same scope");
      expect(
        asRecord(duplicateName.json).error === "mcp_server_name_taken" &&
          !duplicateName.text.includes("UNIQUE"),
        `a duplicate name answers mcp_server_name_taken without SQLite text, got ${duplicateName.text.slice(0, 200)}`,
      );

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

      // ── MCP OAuth against a loopback authorization server ──────────────────
      // The SUT allows private hosts for OAuth discovery, so the success paths run for real:
      // metadata, dynamic client registration, authorize url, callback, status, refresh,
      // refresh failures and disconnect.
      const as = startAuthorizationServer();
      cleanup.add("stop the authorization server", async () => as.stop());
      const oauthCreated = await ctx.api("POST", "/api/mcp-servers", {
        body: {
          name: `e2e-oauth-${ctx.nonce}`,
          transport: "http",
          scope: "swarm",
          url: `${as.origin}/mcp`,
        },
      });
      expectStatus(oauthCreated, [201], "register the loopback authorization server's resource");
      const oauthServer = serverOf(oauthCreated.json);
      cleanup.add("delete the oauth server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${oauthServer.id}`);
      });
      const oauthId = oauthServer.id;
      const callbackSuffix = "/api/mcp-oauth/callback";

      const metadata = await ctx.api("GET", `/api/mcp-oauth/${oauthId}/metadata`);
      expectStatus(metadata, [200], "oauth metadata of a loopback server");
      const found = asRecord(metadata.json);
      expect(
        found.requiresOAuth === true &&
          found.resourceUrl === `${as.origin}/mcp` &&
          found.authorizationServerIssuer === as.origin &&
          found.authorizeUrl === `${as.origin}/authorize` &&
          found.tokenUrl === `${as.origin}/token` &&
          found.revocationUrl === `${as.origin}/revoke` &&
          found.registrationEndpoint === `${as.origin}/register` &&
          found.dcrSupported === true &&
          JSON.stringify(found.scopes) === JSON.stringify(["read", "write"]) &&
          JSON.stringify(found.bearerMethodsSupported) === JSON.stringify(["header"]) &&
          Array.isArray(found.tokenEndpointAuthMethodsSupported) &&
          found.tokenEndpointAuthMethodsSupported.includes("client_secret_basic"),
        `metadata reports the discovered endpoints: ${metadata.text.slice(0, 400)}`,
      );

      // A failed discovery is a 502 that names the failure; the server recovers afterwards.
      as.state.metadata = "down";
      const probe = await ctx.api("GET", `/api/mcp-oauth/${oauthId}/metadata`);
      expectStatus(probe, [502], "oauth metadata when the authorization server is down");
      expect(
        String(asRecord(probe.json).error).startsWith("Metadata discovery failed"),
        "the 502 names the discovery failure",
      );
      as.state.metadata = "ok";
      expectStatus(
        await ctx.api("GET", `/api/mcp-oauth/${oauthId}/metadata`),
        [200],
        "oauth metadata after the authorization server recovers",
      );

      // The SUT's own MCP endpoint advertises no protected-resource metadata.
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
      const selfMetadata = await ctx.api("GET", `/api/mcp-oauth/${self.id}/metadata`);
      expectStatus(selfMetadata, [200], "oauth metadata of a server without OAuth");
      expect(
        asRecord(selfMetadata.json).requiresOAuth === false,
        "a server that advertises no OAuth metadata reports requiresOAuth=false",
      );

      // Authorize: the authorization server supports DCR, so the first call registers a client.
      const registeredClients = () => as.requests.filter((r) => r.path === "/register").length;
      const doneUrl = "https://app.example.com/mcp-oauth-done";
      const built = await ctx.api(
        "GET",
        `/api/mcp-oauth/${oauthId}/authorize-url?redirect=${encodeURIComponent(doneUrl)}`,
      );
      expectStatus(built, [200], "build the authorize url with dynamic client registration");
      const dcrProvider = new URL(String(asRecord(built.json).providerUrl));
      const dcrParams = dcrProvider.searchParams;
      expect(
        `${dcrProvider.origin}${dcrProvider.pathname}` === `${as.origin}/authorize` &&
          dcrParams.get("client_id") === "dcr-1" &&
          dcrParams.get("response_type") === "code" &&
          dcrParams.get("scope") === "read write" &&
          dcrParams.get("resource") === `${as.origin}/mcp` &&
          dcrParams.get("code_challenge_method") === "S256" &&
          (dcrParams.get("redirect_uri") ?? "").endsWith(callbackSuffix),
        `the provider url carries the registered client, scopes, resource and PKCE: ${dcrProvider}`,
      );
      const registrations = as.requests.filter((r) => r.path === "/register");
      const registration = asRecord(registrations[0]?.json);
      expect(
        registrations.length === 1 &&
          registration.client_name === `agent-swarm (${oauthServer.name})` &&
          registration.token_endpoint_auth_method === "client_secret_basic" &&
          registration.scope === "read write" &&
          Array.isArray(registration.grant_types) &&
          registration.grant_types.includes("refresh_token") &&
          Array.isArray(registration.redirect_uris) &&
          String(registration.redirect_uris[0]).endsWith(callbackSuffix),
        `the swarm registers itself with the discovered endpoint: ${registrations[0]?.text}`,
      );
      const beforeCallback = asRecord(
        (await ctx.api("GET", `/api/mcp-oauth/${oauthId}/status`)).json,
      );
      expect(
        beforeCallback.connected === false && beforeCallback.token === null,
        "a started flow is not a connection until the callback",
      );
      // A second authorize call reuses the registered client instead of registering again.
      const rebuilt = await ctx.api("GET", `/api/mcp-oauth/${oauthId}/authorize-url`);
      expectStatus(rebuilt, [200], "build the authorize url again");
      const rebuiltParams = new URL(String(asRecord(rebuilt.json).providerUrl)).searchParams;
      expect(
        rebuiltParams.get("client_id") === "dcr-1" && registeredClients() === 1,
        "a second authorize call reuses the registered client",
      );

      // Callback: the code is exchanged at the token endpoint with the client's credentials.
      const goodState = String(dcrParams.get("state"));
      const connected = await ctx.api(
        "GET",
        `/api/mcp-oauth/callback?state=${encodeURIComponent(goodState)}&code=code-${ctx.nonce}`,
        { apiKey: null, redirect: "manual" },
      );
      expectStatus(connected, [302], "mcp callback with a valid code");
      const connectedTarget = new URL(connected.headers.get("location") ?? "http://invalid");
      expect(
        `${connectedTarget.origin}${connectedTarget.pathname}` === doneUrl &&
          connectedTarget.searchParams.get("oauth") === "success",
        `a successful callback redirects back with oauth=success: ${connectedTarget}`,
      );
      const exchange = tokenRequests(as, "authorization_code");
      expect(
        exchange.length === 1 &&
          exchange[0]?.form.get("code") === `code-${ctx.nonce}` &&
          (exchange[0]?.form.get("code_verifier") ?? "").length >= 43 &&
          exchange[0]?.form.get("resource") === `${as.origin}/mcp` &&
          (exchange[0]?.form.get("redirect_uri") ?? "").endsWith(callbackSuffix) &&
          basicCredentials(exchange[0]) === "dcr-1:dcr-secret-1",
        `the code exchange sends the verifier, resource and the client's Basic credentials: ${exchange[0]?.text}`,
      );
      expectStatus(
        await ctx.api(
          "GET",
          `/api/mcp-oauth/callback?state=${encodeURIComponent(goodState)}&code=again`,
          { apiKey: null },
        ),
        [400],
        "a consumed mcp state cannot be replayed",
      );
      // The user abandons the second attempt. A live pending attempt would keep offering its
      // client for reuse, which the disowned-client step below must not meet.
      expectStatus(
        await ctx.api(
          "GET",
          `/api/mcp-oauth/callback?state=${encodeURIComponent(String(rebuiltParams.get("state")))}&error=access_denied`,
          { apiKey: null, redirect: "manual" },
        ),
        [302],
        "the abandoned second attempt is denied",
      );

      // Status with a live token never exposes the token or the client credentials.
      const live = await ctx.api("GET", `/api/mcp-oauth/${oauthId}/status`);
      const liveStatus = asRecord(live.json);
      const liveToken = asRecord(liveStatus.token);
      expect(
        liveStatus.connected === true &&
          liveStatus.authMethod === "oauth" &&
          liveToken.status === "connected" &&
          liveToken.scope === "read write" &&
          liveToken.clientSource === "dcr" &&
          liveToken.hasRefreshToken === true &&
          liveToken.authorizationServerIssuer === as.origin &&
          liveToken.resourceUrl === `${as.origin}/mcp` &&
          liveToken.lastErrorMessage === null &&
          typeof liveToken.lastRefreshedAt === "string" &&
          typeof liveToken.expiresAt === "string" &&
          new Date(String(liveToken.expiresAt)).getTime() > Date.now(),
        `a connected server reports a live token: ${live.text.slice(0, 500)}`,
      );
      expect(
        !/at-\d|rt-\d|dcr-secret/.test(live.text),
        "status never carries the tokens or the client secret",
      );
      const oauthAgent = await registerAgent(ctx, "mcp-oauth");
      expectStatus(
        await ctx.api("POST", `/api/mcp-servers/${oauthId}/install`, {
          body: { agentId: oauthAgent },
        }),
        [200],
        "install the oauth server for an agent",
      );
      const bearerOf = async (label: string) => {
        const list = await ctx.api(
          "GET",
          `/api/agents/${oauthAgent}/mcp-servers?resolveSecrets=true`,
        );
        expectStatus(list, [200], label);
        const row = asRecords(list.json, "servers").find((s) => s.id === oauthId);
        return String(asRecord(row?.resolvedHeaders).Authorization);
      };
      expect(
        (await bearerOf("resolve the oauth bearer")) === "Bearer at-1",
        "the agent's resolved headers carry the connection's access token",
      );

      // Refresh rotates the access token.
      const refreshed = await ctx.api("POST", `/api/mcp-oauth/${oauthId}/refresh`, { body: {} });
      expectStatus(refreshed, [200], "refresh the connection");
      const refreshBody = asRecord(refreshed.json);
      expect(
        refreshBody.ok === true &&
          refreshBody.scope === "read write" &&
          typeof refreshBody.expiresAt === "string",
        `refresh answers ok with the expiry and scope: ${refreshed.text}`,
      );
      const refreshGrants = tokenRequests(as, "refresh_token");
      expect(
        refreshGrants.length === 1 &&
          refreshGrants[0]?.form.get("refresh_token") === "rt-1" &&
          refreshGrants[0]?.form.get("resource") === `${as.origin}/mcp` &&
          basicCredentials(refreshGrants[0]) === "dcr-1:dcr-secret-1",
        `the refresh sends the stored refresh token and client credentials: ${refreshGrants[0]?.text}`,
      );
      expect(
        (await bearerOf("resolve the rotated bearer")) === "Bearer at-2",
        "a refresh replaces the stored access token",
      );

      // A token endpoint failure is a 500 that names it, and the connection stays usable.
      as.state.refresh = "server_error";
      const failedRefresh = await ctx.api("POST", `/api/mcp-oauth/${oauthId}/refresh`, {
        body: {},
      });
      expectStatus(failedRefresh, [500], "refresh when the token endpoint fails");
      expect(
        String(asRecord(failedRefresh.json).error).startsWith(
          "Refresh failed: Token refresh failed (500)",
        ),
        `the 500 names the token endpoint failure: ${failedRefresh.text}`,
      );
      expect(
        asRecord((await ctx.api("GET", `/api/mcp-oauth/${oauthId}/status`)).json).connected ===
          true,
        "a transient refresh failure leaves the connection connected",
      );

      // invalid_client means the provider disowned the client: the token is flagged as an error
      // and the next authorize registers a fresh client.
      as.state.refresh = "invalid_client";
      const disowned = await ctx.api("POST", `/api/mcp-oauth/${oauthId}/refresh`, { body: {} });
      expectStatus(disowned, [500], "refresh with a disowned client");
      expect(
        String(asRecord(disowned.json).error).includes("invalid_client"),
        `the 500 names invalid_client: ${disowned.text}`,
      );
      const errored = asRecord((await ctx.api("GET", `/api/mcp-oauth/${oauthId}/status`)).json);
      expect(
        errored.connected === false &&
          asRecord(errored.token).status === "error" &&
          String(asRecord(errored.token).lastErrorMessage).includes("invalid_client"),
        `a disowned client marks the token as an error: ${JSON.stringify(errored)}`,
      );
      as.state.refresh = "ok";
      const reauthorized = await ctx.api("GET", `/api/mcp-oauth/${oauthId}/authorize-url`);
      expectStatus(reauthorized, [200], "authorize again after the client was disowned");
      const reauthUrl = new URL(String(asRecord(reauthorized.json).providerUrl));
      expect(
        reauthUrl.searchParams.get("client_id") === "dcr-2" && registeredClients() === 2,
        `a disowned client is replaced by a fresh registration: ${reauthUrl} after ${registeredClients()} registration(s)`,
      );
      const reconnected = await ctx.api(
        "GET",
        `/api/mcp-oauth/callback?state=${encodeURIComponent(String(reauthUrl.searchParams.get("state")))}&code=code2-${ctx.nonce}`,
        { apiKey: null, redirect: "manual" },
      );
      expectStatus(reconnected, [302], "mcp callback after re-registering");
      expect(
        asRecord((await ctx.api("GET", `/api/mcp-oauth/${oauthId}/status`)).json).connected ===
          true,
        "the connection recovers after re-authorizing",
      );

      // A rejected code redirects back with the provider's error and connects nothing new.
      const badAuthorize = await ctx.api("GET", `/api/mcp-oauth/${oauthId}/authorize-url`);
      const badState = new URL(String(asRecord(badAuthorize.json).providerUrl)).searchParams.get(
        "state",
      );
      const rejected = await ctx.api(
        "GET",
        `/api/mcp-oauth/callback?state=${encodeURIComponent(String(badState))}&code=bad`,
        { apiKey: null, redirect: "manual" },
      );
      expectStatus(rejected, [302], "mcp callback with a rejected code");
      const rejectedTarget = new URL(rejected.headers.get("location") ?? "http://invalid");
      expect(
        rejectedTarget.searchParams.get("oauth") === "error" &&
          (rejectedTarget.searchParams.get("error_description") ?? "").includes(
            "Token exchange failed (400)",
          ),
        `a rejected code redirects back with oauth=error: ${rejectedTarget}`,
      );

      // Disconnect revokes at the provider once. It is idempotent: the revoked row is kept.
      const revokedBefore = as.requests.filter((r) => r.path === "/revoke").length;
      expectStatus(
        await ctx.api("DELETE", `/api/mcp-oauth/${oauthId}`),
        [200],
        "disconnect the oauth server",
      );
      const revocations = as.requests.filter((r) => r.path === "/revoke");
      expect(
        revocations.length === revokedBefore + 1 &&
          /^at-\d+$/.test(revocations[revocations.length - 1]?.form.get("token") ?? "") &&
          basicCredentials(revocations[revocations.length - 1]) === "dcr-2:dcr-secret-2",
        "disconnect revokes the access token at the provider with the client's credentials",
      );
      const revokedStatus = asRecord(
        (await ctx.api("GET", `/api/mcp-oauth/${oauthId}/status`)).json,
      );
      expect(
        revokedStatus.connected === false &&
          revokedStatus.authMethod === "static" &&
          asRecord(revokedStatus.token).status === "revoked",
        "disconnect keeps the row as revoked and returns the server to static auth",
      );
      expectStatus(
        await ctx.api("DELETE", `/api/mcp-oauth/${oauthId}`),
        [200],
        "disconnect a revoked connection again",
      );
      expect(
        as.requests.filter((r) => r.path === "/revoke").length === revokedBefore + 1,
        "a repeat disconnect does not call the provider again",
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
