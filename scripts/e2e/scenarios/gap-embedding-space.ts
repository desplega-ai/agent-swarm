import { asRecord, expect, expectStatus, pollUntil } from "../http";
import { SkipError } from "../report";
import type { Scenario, ScenarioContext } from "../run";

// PR #2487: a change of embedding model re-embeds stored vectors in the background; an
// unrelated reload does not; flipping back restores the first space's vectors.
// Run via: bun scripts/e2e-gap/embedding-stub.ts gap-embedding-space
type Stats = { requests: number; inputs: number; byModel: Record<string, number> };

async function stats(base: string): Promise<Stats> {
  return (await (await fetch(`${base}/__stats`)).json()) as Stats;
}

function vectors(ctx: ScenarioContext, ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const row = ctx.db.get<{ hex: string | null }>(
      "SELECT hex(embedding) AS hex FROM agent_memory WHERE id = ?",
      [id],
    );
    out.set(id, row?.hex ?? "");
  }
  return out;
}

async function setConfig(ctx: ScenarioContext, key: string, value: string) {
  expectStatus(
    await ctx.api("PUT", "/api/config", {
      body: { scope: "global", scopeId: null, key, value, isSecret: false },
    }),
    [200],
    `set ${key}`,
  );
}

export const gapEmbeddingSpace: Scenario = {
  name: "gap-embedding-space",
  order: 1060,
  async run(ctx) {
    const base = process.env.GAP_EMB_URL;
    if (!base) throw new SkipError("GAP_EMB_URL not set (use scripts/e2e-gap/embedding-stub.ts)");
    const N = 5;

    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const res = await ctx.api("POST", "/api/memory/index", {
        body: {
          content: `gap embedding space memory ${i} ${ctx.nonce}`,
          name: `gap-emb-${i}-${ctx.nonce}`,
          scope: "swarm",
          source: "manual",
        },
      });
      expectStatus(res, [202], "index memory");
      ids.push(...((asRecord(res.json).memoryIds as string[]) ?? []));
    }
    expect(ids.length === N, `expected ${N} memory ids, got ${ids.length}`);
    expect(
      await pollUntil(() => [...vectors(ctx, ids).values()].every((hex) => hex.length > 0), 20_000),
      "memories never got a vector from the stub",
    );
    const spaceA = vectors(ctx, ids);
    // Boot also backfills the seeded scripts through the stub; wait until the count settles.
    let afterIndex = await stats(base);
    let stable = 0;
    for (let i = 0; i < 40 && stable < 4; i++) {
      await Bun.sleep(1000);
      const now = await stats(base);
      stable = now.inputs === afterIndex.inputs ? stable + 1 : 0;
      afterIndex = now;
    }
    expect(stable >= 4, "stub input count never settled after boot");
    expect((afterIndex.byModel["gap-model-a"] ?? 0) >= N, "stub never saw gap-model-a inputs");

    // Control: an unrelated reload does not re-embed.
    await setConfig(ctx, "MEMORY_RECENCY_HALF_LIFE_DAYS", "90");
    await Bun.sleep(4000);
    const afterReload = await stats(base);
    expect(
      afterReload.inputs === afterIndex.inputs,
      `unrelated reload re-embedded: ${afterIndex.inputs} -> ${afterReload.inputs}`,
    );

    // Space change: new model => every stored memory moves to the new space.
    await setConfig(ctx, "EMBEDDING_MODEL", "gap-model-b");
    const moved = await pollUntil(() => {
      const now = vectors(ctx, ids);
      return ids.every((id) => now.get(id) !== spaceA.get(id) && (now.get(id) ?? "").length > 0);
    }, 40_000);
    expect(moved, "stored memories were not re-embedded after the model change");
    const afterB = await stats(base);
    expect(
      (afterB.byModel["gap-model-b"] ?? 0) >= N,
      `stub saw ${afterB.byModel["gap-model-b"] ?? 0} gap-model-b inputs, expected >= ${N}`,
    );
    const marker = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM seed_state WHERE key LIKE 'embedding-space%'",
    );
    ctx.log(`gap-embedding-space: ${marker?.n ?? 0} embedding-space seed_state rows`);

    // Flip back: deterministic stub reproduces the first space's vectors.
    await setConfig(ctx, "EMBEDDING_MODEL", "gap-model-a");
    const back = await pollUntil(() => {
      const now = vectors(ctx, ids);
      return ids.every((id) => now.get(id) === spaceA.get(id));
    }, 40_000);
    expect(back, "flipping the model back did not restore the first space's vectors");
  },
};
