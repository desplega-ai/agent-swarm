import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

const NOT_ALLOWED = "The endpoint URL is not allowed.";

/**
 * The onboarding embeddings probe sends its request through the DNS-resolving outbound guard.
 * In development a loopback endpoint is still reached. In production a hostname the guard
 * cannot clear is refused before any request, and the deployment's own endpoint still works.
 */
export const onboardingEmbeddingEndpointGuard: Scenario = {
  name: "onboarding-embedding-endpoint-guard",
  // Before github-installation-token-repos (656): this scenario restarts the API, and the boot
  // sweep fails in_progress tasks 5 s after a restart. The strict gate needs that status in the
  // final database, so no new restart may come later than the suite's own late restarts.
  order: 638,
  async run(ctx) {
    const memory = (body: Record<string, unknown>) =>
      ctx.api("POST", "/api/onboarding/memory", { body });
    const storedEmbeddingRows = () =>
      ctx.db.query<{ key: string }>(
        "SELECT key FROM swarm_config WHERE scope = 'global' AND key LIKE 'EMBEDDING_%'",
      );
    expect(
      storedEmbeddingRows().length === 0,
      "An earlier scenario left a stored embeddings configuration",
    );

    // ===== development: a loopback endpoint is reached =====
    let hits = 0;
    const local = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        hits += 1;
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      },
    });
    try {
      const response = await memory({
        preset: "custom",
        baseUrl: `http://127.0.0.1:${local.port}/v1`,
        apiKey: `k-${ctx.nonce}`,
      });
      expectStatus(response, [200], "probe a loopback endpoint in development");
      expect(
        asRecord(response.json).errorClass === "auth" && hits === 1,
        `The loopback endpoint was not reached: ${JSON.stringify(response.json)}, ${hits} hits`,
      );
    } finally {
      local.stop(true);
    }

    // ===== production: the guard applies, the deployment endpoint is exempt =====
    try {
      await ctx.restartSut({
        env: {
          NODE_ENV: "production",
          EMBEDDING_API_BASE_URL: `${ctx.llm.origin}/v1`,
          EMBEDDING_API_KEY: `k-${ctx.nonce}`,
          EMBEDDING_MODEL: "text-embedding-3-small",
        },
      });

      const refused = await memory({
        preset: "custom",
        baseUrl: `https://embeddings-${ctx.nonce}.invalid/v1`,
        apiKey: `k-${ctx.nonce}`,
      });
      expectStatus(refused, [200], "probe a hostname the guard cannot clear");
      expect(
        asRecord(refused.json).ok === false && asRecord(refused.json).error === NOT_ALLOWED,
        `The probe was not refused by the guard: ${JSON.stringify(refused.json)}`,
      );

      const existing = await memory({ preset: "existing" });
      expectStatus(existing, [200], "probe the deployment's own endpoint");
      expect(
        asRecord(existing.json).ok === true && asRecord(existing.json).dimensions === 512,
        `The deployment endpoint failed: ${JSON.stringify(existing.json)}`,
      );
      expect(storedEmbeddingRows().length === 0, "A probe stored an embeddings configuration");
    } finally {
      await ctx.restartSut();
    }
  },
};
