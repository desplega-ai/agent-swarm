import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callToolErr,
  callToolOk,
  getLead,
  registerAgent,
  runScript,
  type Stub,
  startStub,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

function openapiSpec(origin: string): string {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "E2E API", version: "1.0.0" },
    servers: [{ url: `${origin}/v1` }],
    paths: {
      "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
      "/items/{id}": {
        get: {
          operationId: "getItem",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
}

/** A one-tool MCP server over plain JSON-RPC, enough for the script MCP proxy. */
function mcpResponse(body: string): Response {
  const rpc = JSON.parse(body || "{}") as { id?: unknown; method?: string; params?: unknown };
  if (rpc.method === "initialize") {
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "e2e-stub", version: "1" },
      },
    });
  }
  if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (rpc.method === "tools/list") {
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo text back",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
  }
  if (rpc.method === "tools/call") {
    const args = asRecord(asRecord(rpc.params).arguments ?? {});
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: { content: [{ type: "text", text: `echo:${String(args.text)}` }] },
    });
  }
  return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "no" } });
}

async function connectionOf(ctx: ScenarioContext, id: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/script-connections/${id}`);
  expectStatus(response, [200], "get connection");
  return asRecord(asRecord(response.json).connection);
}

/**
 * Flow `script-connections`: create/list/get/refresh/disable/delete for openapi, graphql, sql
 * and mcp connections; a script's ctx.api call that carries the connection's bearer secret out
 * to a loopback stub (the script itself only ever sees the redacted value); the MCP and SQL
 * proxy routes; the lead-only `script-connections` MCP tool. NODE_ENV=test lets the API
 * reach loopback hosts, so the stub stands in for a real upstream.
 */
export const scriptConnections: Scenario = {
  name: "script-connections",
  order: 450,
  async run(ctx) {
    const workerId = await registerAgent(ctx, "conn");
    const leadId = await getLead(ctx);
    const secret = `e2e-conn-secret-${ctx.nonce}-0123456789`;
    const stub: Stub = startStub((request, body) => {
      const path = new URL(request.url).pathname;
      if (path === "/mcp") return mcpResponse(body);
      if (path === "/spec.json")
        return new Response(openapiSpec(stub.origin), {
          headers: { "Content-Type": "application/json" },
        });
      return Response.json({ pong: true, authSeen: request.headers.get("authorization") });
    });
    const cleanup: Array<() => Promise<unknown>> = [];
    try {
      // ── create an OpenAPI connection with inline bearer auth ──
      const slug = `e2e-open-${ctx.nonce}`;
      const created = await ctx.api("POST", "/api/script-connections", {
        body: {
          kind: "openapi",
          slug,
          displayName: "E2E OpenAPI",
          openapiSpecJson: openapiSpec(stub.origin),
          auth: { type: "bearer", secret, hosts: [stub.hostname] },
        },
      });
      expectStatus(created, [200], "create openapi connection");
      const connection = asRecord(asRecord(created.json).connection);
      const connectionId = asString(connection.id, "connection id");
      cleanup.push(() => ctx.api("DELETE", `/api/script-connections/${connectionId}`));
      // slugs are normalised to a camelCase identifier for ctx.api
      const accessor = asString(connection.slug, "normalised slug");
      expect(
        accessor !== slug && /^[a-zA-Z][a-zA-Z0-9]*$/.test(accessor),
        `slug must be normalised to an identifier, got ${accessor}`,
      );
      expect(
        connection.kind === "openapi" &&
          connection.scope === "global" &&
          connection.enabled === true &&
          connection.version === 1 &&
          connection.baseUrl === `${stub.origin}/v1` &&
          connection.baseUrlSource === "spec" &&
          connection.operationCount === 2 &&
          connection.generationError === null &&
          connection.authType === "bearer" &&
          connection.openapiSpecSourceKind === "inline",
        `connection record is wrong: ${JSON.stringify(connection).slice(0, 600)}`,
      );
      expect(
        JSON.stringify(connection.allowedHosts) === JSON.stringify([stub.hostname]),
        "allowedHosts must come from auth.hosts",
      );
      expect(
        !JSON.stringify(created.json).includes(secret),
        "the connection record must never carry the inline secret",
      );
      const dbRow = ctx.db.get<{ kind: string; auth_type: string; credential_binding_id: string }>(
        "SELECT kind, auth_type, credential_binding_id FROM script_connections WHERE id = ?",
        [connectionId],
      );
      expect(
        dbRow?.kind === "openapi" && dbRow.auth_type === "bearer" && dbRow.credential_binding_id,
        "the connection row and its managed credential binding must be persisted",
      );

      // ── list (filters) and get (detail) ──
      const listed = await ctx.api("GET", "/api/script-connections?kind=openapi");
      expectStatus(listed, [200], "list openapi connections");
      expect(
        asRecords(listed.json, "connections").some((entry) => entry.id === connectionId),
        "the connection is missing from the list",
      );
      const otherKind = await ctx.api("GET", "/api/script-connections?kind=graphql");
      expect(
        !asRecords(otherKind.json, "connections").some((entry) => entry.id === connectionId),
        "the kind filter must exclude the openapi connection",
      );
      expectStatus(await ctx.api("GET", "/api/script-connections?kind=bogus"), [400], "bad kind");
      const detail = await connectionOf(ctx, connectionId);
      expect(
        asRecords(detail, "operations")
          .map((op) => op.name)
          .sort()
          .join(",") === "getItem,ping" &&
          String(detail.generatedTypes).includes("PingResponse") &&
          detail.graphql === false,
        `connection detail lacks operations or generated types: ${JSON.stringify(detail).slice(0, 400)}`,
      );
      expectStatus(
        await ctx.api("GET", `/api/script-connections/${UNKNOWN_ID}`),
        [404],
        "get unknown",
      );
      expectStatus(await ctx.api("GET", "/api/script-connections/nope"), [400], "get bad id");

      // ── the connection's types reach the script type surface ──
      const defs = asRecord((await ctx.api("GET", "/api/scripts/type-defs")).json);
      expect(
        String(defs.sdkTypes).includes(
          `${accessor.charAt(0).toUpperCase()}${accessor.slice(1)}PingResponse`,
        ),
        "type-defs must include the connection's generated types",
      );

      // ── ctx.api reaches the upstream with the secret; the script only sees the redaction ──
      const call = await runScript(ctx, workerId, {
        source: `export default async function (args: unknown, ctx: any) { return await ctx.api.${accessor}.ping(); }`,
        intent: `e2e ctx.api ${ctx.nonce}`,
      });
      expect(
        call.exitCode === 0 && call.error === undefined,
        `ctx.api call failed: ${JSON.stringify(call).slice(0, 400)}`,
      );
      expect(asRecord(call.result).pong === true, "ctx.api did not return the upstream body");
      const upstream = stub.seen.find((request) => request.path === "/v1/ping");
      expect(upstream, "the stub never received the ctx.api request");
      expect(
        upstream.headers.authorization === `Bearer ${secret}`,
        "the upstream must receive the real bearer secret",
      );
      expect(
        !JSON.stringify(call).includes(secret) &&
          String(asRecord(call.result).authSeen).includes("[REDACTED"),
        "the script and its result must only ever see the redacted secret",
      );

      // ── update through the same slug; disable blocks use; enable restores it ──
      const updated = await ctx.api("POST", "/api/script-connections", {
        body: { kind: "openapi", slug, id: connectionId, displayName: "E2E OpenAPI renamed" },
      });
      expectStatus(updated, [200], "update the connection by id");
      const updatedConnection = asRecord(asRecord(updated.json).connection);
      expect(
        updatedConnection.id === connectionId &&
          updatedConnection.displayName === "E2E OpenAPI renamed" &&
          updatedConnection.version === 2 &&
          updatedConnection.operationCount === 2,
        "an update must bump the version and keep the stored spec",
      );
      const refreshInline = await ctx.api(
        "POST",
        `/api/script-connections/${connectionId}/refresh`,
      );
      expectStatus(refreshInline, [400], "refresh an inline-spec connection");
      expect(
        String(asRecord(refreshInline.json).error).includes("no source to refresh"),
        "refresh of an inline spec must explain there is nothing to refresh from",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${UNKNOWN_ID}/refresh`),
        [404],
        "refresh unknown",
      );
      const disabled = await ctx.api("POST", `/api/script-connections/${connectionId}/disable`, {
        body: { enabled: false },
      });
      expectStatus(disabled, [200], "disable the connection");
      expect(
        asRecord(asRecord(disabled.json).connection).enabled === false,
        "disable must store enabled:false",
      );
      const blocked = await runScript(ctx, workerId, {
        source: `export default async function (args: unknown, ctx: any) { return typeof ctx.api.${accessor}; }`,
        intent: `e2e disabled connection ${ctx.nonce}`,
      });
      expect(blocked.result === "undefined", "a disabled connection must not appear on ctx.api");
      const enabled = await ctx.api("POST", `/api/script-connections/${connectionId}/disable`, {
        body: { enabled: true },
      });
      expect(asRecord(asRecord(enabled.json).connection).enabled === true, "re-enable");
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${connectionId}/disable`, { body: {} }),
        [400],
        "disable without enabled",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${UNKNOWN_ID}/disable`, {
          body: { enabled: false },
        }),
        [404],
        "disable unknown",
      );

      // ── validation: spec sources, kind, generation errors ──
      const noSpec = await ctx.api("POST", "/api/script-connections", {
        body: { kind: "openapi", slug: `e2e-nospec-${ctx.nonce}` },
      });
      expectStatus(noSpec, [400], "openapi without a spec");
      const twoSpecs = await ctx.api("POST", "/api/script-connections", {
        body: {
          kind: "openapi",
          slug: `e2e-twospecs-${ctx.nonce}`,
          openapiSpecJson: openapiSpec(stub.origin),
          openapiSpecUrl: `${stub.origin}/spec.json`,
        },
      });
      expectStatus(twoSpecs, [400], "openapi with two spec sources");
      expectStatus(
        await ctx.api("POST", "/api/script-connections", { body: { kind: "nope", slug: "x" } }),
        [400],
        "unknown kind",
      );
      const brokenSpec = await ctx.api("POST", "/api/script-connections", {
        body: { kind: "openapi", slug: `e2e-broken-${ctx.nonce}`, openapiSpecJson: "{not json" },
      });
      expectStatus(brokenSpec, [200], "an unparseable spec is saved with a generation error");
      const broken = asRecord(asRecord(brokenSpec.json).connection);
      cleanup.push(() => ctx.api("DELETE", `/api/script-connections/${String(broken.id)}`));
      expect(
        typeof broken.generationError === "string" && broken.operationCount === 0,
        "an unparseable spec must surface generationError",
      );

      // ── graphql connection ──
      const graphql = await ctx.api("POST", "/api/script-connections", {
        body: {
          kind: "graphql",
          slug: `e2e-gql-${ctx.nonce}`,
          baseUrl: `${stub.origin}/graphql`,
          allowedHosts: [stub.hostname],
        },
      });
      expectStatus(graphql, [200], "create graphql connection");
      const gql = asRecord(asRecord(graphql.json).connection);
      cleanup.push(() => ctx.api("DELETE", `/api/script-connections/${String(gql.id)}`));
      expect(
        gql.kind === "graphql" && gql.baseUrl === `${stub.origin}/graphql`,
        "graphql connection record is wrong",
      );

      // ── MCP connection + proxy ──
      const server = await ctx.api("POST", "/api/mcp-servers", {
        body: { name: `e2e-conn-mcp-${ctx.nonce}`, transport: "http", url: `${stub.origin}/mcp` },
      });
      expectStatus(server, [201], "register the stub MCP server");
      const mcpServerId = asString(asRecord(asRecord(server.json).server).id, "mcp server id");
      cleanup.push(() => ctx.api("DELETE", `/api/mcp-servers/${mcpServerId}`));
      const mcpConn = await ctx.api("POST", "/api/script-connections", {
        body: { kind: "mcp", slug: `e2e-mcp-${ctx.nonce}`, mcpServerId },
      });
      expectStatus(mcpConn, [200], "create mcp connection");
      const mcpRecord = asRecord(asRecord(mcpConn.json).connection);
      const mcpConnId = asString(mcpRecord.id, "mcp connection id");
      cleanup.unshift(() => ctx.api("DELETE", `/api/script-connections/${mcpConnId}`));
      expect(
        mcpRecord.kind === "mcp" &&
          mcpRecord.mcpServerId === mcpServerId &&
          mcpRecord.toolCount === 1 &&
          mcpRecord.generationError === null,
        `mcp connection did not discover the stub tool: ${JSON.stringify(mcpRecord).slice(0, 500)}`,
      );
      const mcpDetail = await connectionOf(ctx, mcpConnId);
      expect(
        asRecords(mcpDetail, "tools").some((tool) => tool.name === "echo"),
        "mcp connection detail must list the discovered tool",
      );
      const proxied = await ctx.api("POST", `/api/script-connections/${mcpConnId}/mcp-call`, {
        agentId: workerId,
        body: { tool: "echo", arguments: { text: ctx.nonce } },
      });
      expectStatus(proxied, [200], "mcp-call");
      const proxiedBody = asRecord(proxied.json);
      expect(
        proxiedBody.ok === true &&
          JSON.stringify(asRecord(proxiedBody.result).content) ===
            JSON.stringify([{ type: "text", text: `echo:${ctx.nonce}` }]),
        `mcp-call result is wrong: ${proxied.text}`,
      );
      const fromScript = await runScript(ctx, workerId, {
        source: `export default async function (args: { text: string }, ctx: any) {
  return await ctx.mcp.${asString(mcpRecord.slug, "mcp slug")}.echo({ text: args.text });
}`,
        args: { text: `script-${ctx.nonce}` },
        intent: `e2e ctx.mcp ${ctx.nonce}`,
      });
      expect(
        JSON.stringify(asRecord(fromScript.result).content) ===
          JSON.stringify([{ type: "text", text: `echo:script-${ctx.nonce}` }]),
        `ctx.mcp call returned ${JSON.stringify(fromScript.result)}`,
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${mcpConnId}/mcp-call`, {
          body: { tool: "echo" },
        }),
        [400],
        "mcp-call without X-Agent-ID",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${mcpConnId}/mcp-call`, {
          agentId: `no-such-agent-${ctx.nonce}`,
          body: { tool: "echo" },
        }),
        [404],
        "mcp-call as an unknown agent",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${UNKNOWN_ID}/mcp-call`, {
          agentId: workerId,
          body: { tool: "echo" },
        }),
        [404],
        "mcp-call on an unknown connection",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${mcpConnId}/mcp-call`, {
          agentId: workerId,
          body: {},
        }),
        [400],
        "mcp-call without a tool",
      );
      const wrongKind = await ctx.api("POST", `/api/script-connections/${connectionId}/mcp-call`, {
        agentId: workerId,
        body: { tool: "echo" },
      });
      expectStatus(wrongKind, [400], "mcp-call on an openapi connection");
      expect(
        String(asRecord(wrongKind.json).error).includes("not an MCP connection"),
        "mcp-call on the wrong kind must say so",
      );
      // an agent-scoped connection is not available to other agents
      const scoped = await ctx.api("POST", "/api/script-connections", {
        body: {
          kind: "mcp",
          slug: `e2e-mcp-scoped-${ctx.nonce}`,
          mcpServerId,
          scope: "agent",
          scopeId: leadId,
        },
      });
      expectStatus(scoped, [200], "create an agent-scoped mcp connection");
      const scopedId = asString(asRecord(asRecord(scoped.json).connection).id, "scoped id");
      cleanup.unshift(() => ctx.api("DELETE", `/api/script-connections/${scopedId}`));
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${scopedId}/mcp-call`, {
          agentId: workerId,
          body: { tool: "echo", arguments: { text: "x" } },
        }),
        [403],
        "mcp-call on a connection scoped to another agent",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${scopedId}/mcp-call`, {
          agentId: leadId,
          body: { tool: "echo", arguments: { text: "x" } },
        }),
        [200],
        "mcp-call on a connection scoped to this agent",
      );
      await ctx.api("POST", `/api/script-connections/${mcpConnId}/disable`, {
        body: { enabled: false },
      });
      const disabledCall = await ctx.api("POST", `/api/script-connections/${mcpConnId}/mcp-call`, {
        agentId: workerId,
        body: { tool: "echo", arguments: { text: "x" } },
      });
      expectStatus(disabledCall, [403], "mcp-call on a disabled connection");

      // ── SQL connection + proxy (no Postgres here: the documented failure envelope) ──
      const dsnSecret = `p4ss-${ctx.nonce}`;
      const sql = await ctx.api("POST", "/api/script-connections", {
        body: {
          kind: "sql",
          slug: `e2e-sql-${ctx.nonce}`,
          dsn: { secret: `postgres://e2e:${dsnSecret}@127.0.0.1:1/e2e` },
        },
      });
      expectStatus(sql, [200], "create sql connection");
      const sqlRecord = asRecord(asRecord(sql.json).connection);
      const sqlId = asString(sqlRecord.id, "sql connection id");
      cleanup.unshift(() => ctx.api("DELETE", `/api/script-connections/${sqlId}`));
      expect(
        sqlRecord.kind === "sql" && !JSON.stringify(sql.json).includes(dsnSecret),
        "the sql connection must not echo its DSN",
      );
      const query = await ctx.api("POST", `/api/script-connections/${sqlId}/sql-query`, {
        agentId: workerId,
        body: { sql: "select 1 as one" },
      });
      expectStatus(query, [200], "sql-query against an unreachable database");
      const queryBody = asRecord(query.json);
      expect(
        queryBody.ok === false &&
          typeof queryBody.error === "string" &&
          !query.text.includes(dsnSecret),
        `sql-query must report a scrubbed connection failure: ${query.text}`,
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${sqlId}/sql-query`, {
          agentId: workerId,
          body: {},
        }),
        [400],
        "sql-query without sql",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${sqlId}/sql-query`, {
          body: { sql: "select 1" },
        }),
        [400],
        "sql-query without X-Agent-ID",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${connectionId}/sql-query`, {
          agentId: workerId,
          body: { sql: "select 1" },
        }),
        [400],
        "sql-query on an openapi connection",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${UNKNOWN_ID}/sql-query`, {
          agentId: workerId,
          body: { sql: "select 1" },
        }),
        [404],
        "sql-query on an unknown connection",
      );
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${sqlId}/sql-query`, {
          agentId: `no-such-agent-${ctx.nonce}`,
          body: { sql: "select 1" },
        }),
        [404],
        "sql-query as an unknown agent",
      );
      await ctx.api("POST", `/api/script-connections/${sqlId}/disable`, {
        body: { enabled: false },
      });
      expectStatus(
        await ctx.api("POST", `/api/script-connections/${sqlId}/sql-query`, {
          agentId: workerId,
          body: { sql: "select 1" },
        }),
        [403],
        "sql-query on a disabled connection",
      );

      // ── a URL-sourced spec: the connection fetches it, and refresh fetches it again ──
      const urlSlug = `e2e-url-${ctx.nonce}`;
      const fromUrl = await ctx.api("POST", "/api/script-connections", {
        body: { kind: "openapi", slug: urlSlug, openapiSpecUrl: `${stub.origin}/spec.json` },
      });
      expectStatus(fromUrl, [200], "create a connection from a spec URL");
      const urlConn = asRecord(asRecord(fromUrl.json).connection);
      const urlConnId = asString(urlConn.id, "url connection id");
      cleanup.push(() => ctx.api("DELETE", `/api/script-connections/${urlConnId}`));
      expect(
        urlConn.openapiSpecSourceKind === "url" &&
          urlConn.openapiSpecSource === `${stub.origin}/spec.json` &&
          urlConn.operationCount === 2 &&
          typeof urlConn.openapiSpecFetchedAt === "string",
        `a URL-sourced connection must record its source: ${JSON.stringify(urlConn).slice(0, 500)}`,
      );
      const specFetches = () => stub.seen.filter((request) => request.path === "/spec.json").length;
      const fetchesBefore = specFetches();
      const refreshed = await ctx.api("POST", `/api/script-connections/${urlConnId}/refresh`);
      expectStatus(refreshed, [200], "refresh a URL-sourced connection");
      expect(
        asRecord(asRecord(refreshed.json).connection).id === urlConnId &&
          specFetches() > fetchesBefore,
        "refresh must fetch the spec URL again",
      );

      // ── the lead-only `script-connections` MCP tool ──
      const connectionIds = async (): Promise<Map<string, string>> => {
        const response = await ctx.api("GET", "/api/script-connections");
        expectStatus(response, [200], "list connections");
        return new Map(
          asRecords(response.json, "connections").map((entry) => [
            String(entry.id),
            String(entry.slug),
          ]),
        );
      };
      await withMcp(ctx, workerId, async (mcp) => {
        const denied = await callToolErr(mcp, "script-connections", { action: "list" });
        expect(
          toolText(denied).includes("Only the lead can manage script connections"),
          "a worker must not manage script connections",
        );
      });
      await withMcp(ctx, leadId, async (mcp) => {
        // The tool answers with every connection, so its structured copy is cut for long
        // lists: assert on the API after each action instead of parsing the tool payload.
        const listedByTool = await callToolOk(mcp, "script-connections", { action: "list" });
        expect(
          String(structured(listedByTool).message).startsWith("Found "),
          "list must summarise the connection count",
        );
        const before = await connectionIds();
        const savedByTool = await callToolOk(mcp, "script-connections", {
          action: "upsert-openapi",
          slug: `e2e-tool-open-${ctx.nonce}`,
          openapiSpecJson: openapiSpec(stub.origin),
          auth: { type: "bearer", secret: `${secret}-tool`, hosts: [stub.hostname] },
        });
        expect(toolText(savedByTool).includes("saved"), "upsert-openapi text");
        const afterOpenapi = await connectionIds();
        const created = [...afterOpenapi.keys()].filter((id) => !before.has(id));
        expect(created.length === 1, "upsert-openapi must create exactly one connection");
        const toolConnId = asString(created[0], "tool connection id");
        cleanup.push(() => ctx.api("DELETE", `/api/script-connections/${toolConnId}`));
        const toolRecord = await connectionOf(ctx, toolConnId);
        expect(
          toolRecord.kind === "openapi" && toolRecord.authType === "bearer",
          "the tool-created connection is wrong",
        );

        // refresh re-reads the URL-sourced spec; the inline one has nothing to refresh from
        const fetchesBeforeTool = specFetches();
        const toolRefresh = await callToolOk(mcp, "script-connections", {
          action: "refresh",
          id: urlConnId,
        });
        expect(toolText(toolRefresh).includes("refreshed"), "refresh text");
        expect(specFetches() > fetchesBeforeTool, "tool refresh must fetch the spec URL");
        await callToolErr(mcp, "script-connections", { action: "refresh", id: toolConnId });
        const refreshNoId = await callToolErr(mcp, "script-connections", { action: "refresh" });
        expect(toolText(refreshNoId).includes("id is required for refresh"), "refresh needs id");

        const toolDisabled = await callToolOk(mcp, "script-connections", {
          action: "disable",
          id: toolConnId,
        });
        expect(toolText(toolDisabled).includes("disabled"), "disable text");
        expect((await connectionOf(ctx, toolConnId)).enabled === false, "tool disable not stored");
        const disableNoId = await callToolErr(mcp, "script-connections", { action: "disable" });
        expect(toolText(disableNoId).includes("id is required for disable"), "disable needs id");

        const beforeGraphql = await connectionIds();
        const toolGql = await callToolOk(mcp, "script-connections", {
          action: "upsert-graphql",
          slug: `e2e-tool-gql-${ctx.nonce}`,
          baseUrl: `${stub.origin}/graphql`,
          allowedHosts: [stub.hostname],
        });
        expect(toolText(toolGql).includes("GraphQL connection"), "upsert-graphql text");
        const gqlIds = [...(await connectionIds()).keys()].filter((id) => !beforeGraphql.has(id));
        expect(gqlIds.length === 1, "upsert-graphql must create one connection");
        cleanup.push(() => ctx.api("DELETE", `/api/script-connections/${String(gqlIds[0])}`));
        expect((await connectionOf(ctx, String(gqlIds[0]))).kind === "graphql", "graphql kind");
        const gqlMissing = await callToolErr(mcp, "script-connections", {
          action: "upsert-graphql",
          slug: "x",
        });
        expect(toolText(gqlMissing).includes("baseUrl"), "upsert-graphql args");

        const beforeMcp = await connectionIds();
        const toolMcp = await callToolOk(mcp, "script-connections", {
          action: "upsert-mcp",
          slug: `e2e-tool-mcp-${ctx.nonce}`,
          mcpServerId,
        });
        expect(toolText(toolMcp).includes("MCP connection"), "upsert-mcp text");
        const mcpIds = [...(await connectionIds()).keys()].filter((id) => !beforeMcp.has(id));
        expect(mcpIds.length === 1, "upsert-mcp must create one connection");
        cleanup.unshift(() => ctx.api("DELETE", `/api/script-connections/${String(mcpIds[0])}`));
        const missing = await callToolErr(mcp, "script-connections", { action: "upsert-mcp" });
        expect(toolText(missing).includes("slug and mcpServerId are required"), "upsert-mcp args");
        const noSpecTool = await callToolErr(mcp, "script-connections", {
          action: "upsert-openapi",
          slug: "x",
        });
        expect(toolText(noSpecTool).includes("OpenAPI spec source"), "upsert-openapi args");

        const noId = await callToolErr(mcp, "script-connections", { action: "delete" });
        expect(toolText(noId).includes("id is required for delete"), "delete needs id");
        const deletedByTool = await callToolOk(mcp, "script-connections", {
          action: "delete",
          id: toolConnId,
        });
        expect(toolText(deletedByTool).includes("deleted"), "delete text");
        expectStatus(
          await ctx.api("GET", `/api/script-connections/${toolConnId}`),
          [404],
          "tool-deleted connection",
        );
        const deleteAgain = await callToolErr(mcp, "script-connections", {
          action: "delete",
          id: toolConnId,
        });
        expect(toolText(deleteAgain).includes("not found"), "second delete");
      });

      // ── delete removes the connection and its managed credential binding ──
      const bindingBefore = ctx.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM script_credential_bindings WHERE managed_by_connection_id = ?",
        [connectionId],
      );
      expect(bindingBefore?.n === 1, "the bearer connection must own one managed binding");
      const removed = await ctx.api("DELETE", `/api/script-connections/${connectionId}`);
      expectStatus(removed, [200], "delete the connection");
      expect(
        JSON.stringify(removed.json) === JSON.stringify({ deleted: true, id: connectionId }),
        `delete response is wrong: ${removed.text}`,
      );
      expectStatus(
        await ctx.api("DELETE", `/api/script-connections/${connectionId}`),
        [404],
        "delete again",
      );
      expectStatus(
        await ctx.api("GET", `/api/script-connections/${connectionId}`),
        [404],
        "get deleted",
      );
      const bindingAfter = ctx.db.get<{ n: number }>(
        "SELECT count(*) AS n FROM script_credential_bindings WHERE managed_by_connection_id = ?",
        [connectionId],
      );
      expect(bindingAfter?.n === 0, "deleting a connection must delete its managed binding");
      const gone = await runScript(ctx, workerId, {
        source: `export default async function (args: unknown, ctx: any) { return typeof ctx.api.${accessor}; }`,
        intent: `e2e deleted connection ${ctx.nonce}`,
      });
      expect(gone.result === "undefined", "a deleted connection must leave ctx.api");
    } finally {
      for (const step of cleanup) await step().catch(() => {});
      stub.stop();
    }
  },
};
