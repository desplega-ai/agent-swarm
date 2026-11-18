import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { cleanupStack, jsonResponse, type MockRequest, startMockServer } from "./platform-helpers";

// Outbound URLs that a caller or a remote document supplies:
//   - An OpenAPI spec URL is fetched through the DNS-checking guard. Under NODE_ENV=test the
//     guard allows loopback (the dev posture), so a loopback spec imports. Outside dev/test a
//     public-looking name is resolved and refused when it does not resolve to a public address;
//     ALLOW_PRIVATE_NETWORK_URLS=true keeps the self-hosted opt-in.
//   - MCP OAuth discovery refuses an authorization-server document whose endpoints are not
//     http(s) URLs, so /authorize-url can never hand the browser a script URL.

/** A public DNS name that answers with 127.0.0.1. Without DNS the guard still refuses it. */
const LOOPBACK_DNS_NAME = "localtest.me";

function openapiSpec(origin: string): string {
  return JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Outbound guard spec", version: "1.0.0" },
    servers: [{ url: origin }],
    paths: {
      "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
    },
  });
}

export const platformOutboundUrlGuards: Scenario = {
  name: "platform-outbound-url-guards",
  order: 659,
  async run(ctx) {
    const cleanup = cleanupStack(ctx);
    const spec = startMockServer((request: MockRequest) =>
      request.path === "/spec.json"
        ? new Response(openapiSpec(spec.origin), {
            headers: { "Content-Type": "application/json" },
          })
        : new Response("not found", { status: 404 }),
    );
    cleanup.add("stop the spec server", async () => spec.stop());
    const discovery = { authorizationEndpoint: "javascript:alert(document.domain)//" };
    const oauth = startMockServer((request: MockRequest) => {
      if (request.path === "/.well-known/oauth-protected-resource") {
        return jsonResponse({ resource: `${oauth.origin}/mcp`, authorization_servers: [oauth.origin] });
      }
      if (request.path === "/.well-known/oauth-authorization-server") {
        return jsonResponse({
          issuer: oauth.origin,
          authorization_endpoint: discovery.authorizationEndpoint,
          token_endpoint: `${oauth.origin}/token`,
        });
      }
      return new Response("not found", { status: 404 });
    });
    cleanup.add("stop the oauth server", async () => oauth.stop());
    const createFromUrl = (label: string, url: string) =>
      ctx.api("POST", "/api/script-connections", {
        body: { kind: "openapi", slug: `e2e-guard-${label}-${ctx.nonce}`, openapiSpecUrl: url },
      });
    const deleteConnection = (response: { json: unknown }) => {
      const id = asRecord(asRecord(response.json).connection).id;
      if (typeof id === "string") {
        cleanup.add(`delete connection ${id}`, async () => {
          await ctx.api("DELETE", `/api/script-connections/${id}`);
        });
      }
    };
    let restarted = false;
    try {
      // ── MCP OAuth discovery checks the endpoints the document names ─────────
      const created = await ctx.api("POST", "/api/mcp-servers", {
        body: {
          name: `e2e-oauth-guard-${ctx.nonce}`,
          transport: "http",
          scope: "swarm",
          url: `${oauth.origin}/mcp`,
        },
      });
      expectStatus(created, [201], "register the oauth-protected server");
      const serverId = String(asRecord(asRecord(created.json).server).id);
      cleanup.add("delete the oauth-protected server", async () => {
        await ctx.api("DELETE", `/api/mcp-servers/${serverId}`);
      });
      const refused = await ctx.api("GET", `/api/mcp-oauth/${serverId}/metadata`);
      expectStatus(refused, [502], "discovery with a script authorization endpoint");
      expect(
        refused.text.includes("unsupported protocol"),
        `discovery must name the refused endpoint protocol: ${refused.text.slice(0, 300)}`,
      );
      const refusedAuthorize = await ctx.api("GET", `/api/mcp-oauth/${serverId}/authorize-url`);
      expect(
        refusedAuthorize.status >= 400 && asRecord(refusedAuthorize.json).providerUrl === undefined,
        `authorize-url must not return a provider url: ${refusedAuthorize.status} ${refusedAuthorize.text.slice(0, 300)}`,
      );
      discovery.authorizationEndpoint = `${oauth.origin}/authorize`;
      const accepted = await ctx.api("GET", `/api/mcp-oauth/${serverId}/metadata`);
      expectStatus(accepted, [200], "discovery with an http authorization endpoint");
      expect(
        asRecord(accepted.json).authorizeUrl === `${oauth.origin}/authorize`,
        "discovery returns a valid authorization endpoint unchanged",
      );

      // ── OpenAPI spec URL, dev/test posture: loopback is allowed ─────────────
      const devImport = await createFromUrl("dev", `${spec.origin}/spec.json`);
      expectStatus(devImport, [200], "import a loopback spec under NODE_ENV=test");
      deleteConnection(devImport);

      // ── OpenAPI spec URL, production posture: the name is resolved and checked ──
      restarted = true;
      await ctx.restartSut({ env: { NODE_ENV: "production" } });
      const probesBefore = spec.requests.length;
      const resolved = await createFromUrl(
        "dns",
        `https://${LOOPBACK_DNS_NAME}:${new URL(spec.origin).port}/spec.json`,
      );
      expect(
        resolved.status >= 400 && resolved.text.includes("Outbound request refused"),
        `a name that does not resolve to a public address must be refused before connecting: ${resolved.status} ${resolved.text.slice(0, 300)}`,
      );
      expect(spec.requests.length === probesBefore, "the refused import never reached the server");

      // The self-hosted opt-in still reaches a private spec server.
      await ctx.restartSut({
        env: { NODE_ENV: "production", ALLOW_PRIVATE_NETWORK_URLS: "true" },
      });
      const optIn = await createFromUrl("optin", `${spec.origin}/spec.json`);
      expectStatus(optIn, [200], "import a loopback spec with ALLOW_PRIVATE_NETWORK_URLS=true");
      deleteConnection(optIn);
    } finally {
      // Later scenarios run on the base environment.
      if (restarted) await ctx.restartSut();
      await cleanup.run();
    }
  },
};
