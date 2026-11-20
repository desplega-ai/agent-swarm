import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  cleanupStack,
  deleteConfig,
  jsonResponse,
  type MockRequest,
  putConfig,
  registerAgent,
  reloadConfig,
  startMockServer,
} from "./platform-helpers";

// Outbound URLs that a caller or a remote document supplies:
//   - An OpenAPI spec URL is fetched through the DNS-checking guard. Under NODE_ENV=test the
//     guard allows loopback (the dev posture), so a loopback spec imports. Outside dev/test a
//     public-looking name is resolved and refused when it does not resolve to a public address;
//     ALLOW_PRIVATE_NETWORK_URLS=true keeps the self-hosted opt-in.
//   - The onboarding embeddings probe uses the same guard for a caller-supplied endpoint, with
//     the same three postures.
//   - Memory embeddings use it for an EMBEDDING_API_BASE_URL stored through config. The
//     deployment environment's own value is exempt, so a bundled private endpoint keeps working.
//   - MCP OAuth discovery refuses an authorization-server document whose endpoints are not
//     http(s) URLs, so /authorize-url can never hand the browser a script URL.

/** A public DNS name that answers with 127.0.0.1. Without DNS the guard still refuses it. */
const LOOPBACK_DNS_NAME = "localtest.me";

const ENDPOINT_NOT_ALLOWED = "The endpoint URL is not allowed.";

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
  // Before github-installation-token-repos (656): this scenario restarts the API, and the boot
  // sweep fails in_progress tasks 5 s after a restart. The strict gate needs that status in the
  // final database, so no new restart may come later than the suite's own late restarts.
  order: 636,
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
        return jsonResponse({
          resource: `${oauth.origin}/mcp`,
          authorization_servers: [oauth.origin],
        });
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
    // Closes every connection, so a probe that reaches it is a network failure and saves nothing.
    // That is the memory step state platform-onboarding (642) sets and asserts itself.
    let embeddingConnections = 0;
    const embeddings = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          embeddingConnections += 1;
          socket.end();
        },
        data() {},
      },
    });
    const embeddingsOrigin = `http://127.0.0.1:${embeddings.port}`;
    cleanup.add("stop the embeddings server", async () => embeddings.stop(true));
    const probe = (baseUrl: string) =>
      ctx.api("POST", "/api/onboarding/memory", {
        body: { preset: "custom", baseUrl, apiKey: `k-${ctx.nonce}` },
      });
    const expectProbeReached = async (baseUrl: string, label: string) => {
      const before = embeddingConnections;
      const response = await probe(baseUrl);
      expectStatus(response, [200], label);
      expect(
        asRecord(response.json).errorClass === "network" && embeddingConnections === before + 1,
        `${label}: the endpoint was not reached: ${response.text.slice(0, 300)}`,
      );
    };
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
      await expectProbeReached(
        `${embeddingsOrigin}/v1`,
        "probe a loopback embeddings endpoint under NODE_ENV=test",
      );

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

      // The embeddings probe resolves the name too and refuses it before connecting.
      const embeddingsBefore = embeddingConnections;
      const refusedProbe = await probe(`https://${LOOPBACK_DNS_NAME}:${embeddings.port}/v1`);
      expectStatus(refusedProbe, [200], "probe an embeddings endpoint name that is not public");
      expect(
        asRecord(refusedProbe.json).ok === false &&
          asRecord(refusedProbe.json).error === ENDPOINT_NOT_ALLOWED &&
          embeddingConnections === embeddingsBefore,
        `the embeddings probe must refuse a name that does not resolve to a public address: ${refusedProbe.text.slice(0, 300)}`,
      );

      // A base URL stored through config is checked when memory embeds; the deployment
      // environment's own loopback URL (the mock LLM) is exempt and still embeds.
      const memoryAgent = await registerAgent(ctx, "url-guard-memory");
      const searchMemory = async (label: string) => {
        const response = await ctx.api("POST", "/api/memory/search", {
          agentId: memoryAgent,
          body: { query: `outbound guard ${label} ${ctx.nonce}` },
        });
        expectStatus(response, [200], `memory search ${label}`);
      };
      const stored = await putConfig(ctx, {
        key: "EMBEDDING_API_BASE_URL",
        value: `${embeddingsOrigin}/v1`,
      });
      const storedId = String(stored.id);
      let storedDeleted = false;
      cleanup.add("delete the stored embedding base URL", async () => {
        if (!storedDeleted) await deleteConfig(ctx, storedId);
        await reloadConfig(ctx);
      });
      await reloadConfig(ctx);
      const storedBefore = embeddingConnections;
      await searchMemory("stored");
      expect(
        embeddingConnections === storedBefore,
        "memory embedding must not connect to a private base URL stored through config",
      );
      await deleteConfig(ctx, storedId);
      storedDeleted = true;
      await reloadConfig(ctx);
      const deploymentBefore = ctx.llm.requestsTo("/embeddings").length;
      await searchMemory("deployment");
      expect(
        ctx.llm.requestsTo("/embeddings").length > deploymentBefore,
        "memory embedding must still reach the deployment environment's private base URL",
      );

      // The self-hosted opt-in still reaches a private spec server and embeddings endpoint.
      await ctx.restartSut({
        env: { NODE_ENV: "production", ALLOW_PRIVATE_NETWORK_URLS: "true" },
      });
      const optIn = await createFromUrl("optin", `${spec.origin}/spec.json`);
      expectStatus(optIn, [200], "import a loopback spec with ALLOW_PRIVATE_NETWORK_URLS=true");
      deleteConnection(optIn);
      await expectProbeReached(
        `${embeddingsOrigin}/v1`,
        "probe a loopback embeddings endpoint with ALLOW_PRIVATE_NETWORK_URLS=true",
      );
    } finally {
      // Later scenarios run on the base environment.
      if (restarted) await ctx.restartSut();
      await cleanup.run();
    }
  },
};
