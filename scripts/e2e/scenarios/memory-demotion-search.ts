import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerAgent } from "./knowledge-helpers";

// Memory search with a net-negative rating in the candidate set. A memory with
// beta > alpha makes search look up its demotion evidence (per-rater rating
// mass). On Postgres that lookup once ran on the SQLite-only read pool: list
// answered 500 and search answered 200 with no results. Both must return the
// stored memories on every engine.

async function indexMemory(
  ctx: ScenarioContext,
  agentId: string,
  label: string,
  marker: string,
): Promise<string> {
  const response = await ctx.api("POST", "/api/memory/index", {
    agentId,
    body: {
      content: `Demotion check ${label}: the ${marker} lighthouse keeps a ${label} logbook.`,
      name: `demotion ${label} ${ctx.nonce}`,
      scope: "agent",
      source: "manual",
      agentId,
    },
  });
  expectStatus(response, [202], `index the ${label} memory`);
  const ids = asRecord(response.json).memoryIds;
  expect(Array.isArray(ids) && ids.length === 1, `the ${label} memory was not one chunk`);
  return asString(ids[0], "memory id");
}

function resultIds(json: unknown): string[] {
  return asRecords(json, "results").map((row) => asString(row.id, "result id"));
}

export const memoryDemotionSearch: Scenario = {
  name: "memory-demotion-search",
  order: 512,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "mem-demote");
    const marker = `zephyrine${ctx.nonce}`;
    const rated = await indexMemory(ctx, agentId, "rated", marker);
    const plain = await indexMemory(ctx, agentId, "plain", marker);

    const landed = await pollUntil(
      () =>
        Number(
          ctx.db.get<{ n: number }>(
            sql`SELECT count(*) AS n FROM agent_memory WHERE id IN (${rated}, ${plain})`,
          )?.n,
        ) === 2,
      15_000,
      200,
    );
    expect(landed, "the two indexed memories never landed in agent_memory");

    // An `llm` rating with signal -1 adds its weight to beta only (src/be/memory/raters/store.ts).
    const rate = await ctx.api("POST", "/api/memory/rate", {
      agentId,
      body: {
        events: [
          {
            memoryId: rated,
            signal: -1,
            weight: 1,
            source: "llm",
            reasoning: "e2e: make the posterior net-negative",
          },
        ],
      },
    });
    expectStatus(rate, [200], "rate the memory down");
    expect(asRecord(rate.json).applied === 1, `rating not applied: ${rate.text.slice(0, 300)}`);
    const posterior = ctx.db.get<{ alpha: number; beta: number }>(
      sql`SELECT alpha, beta FROM agent_memory WHERE id = ${rated}`,
    );
    expect(
      posterior !== null && Number(posterior.beta) > Number(posterior.alpha),
      `the rated memory is not net-negative: ${JSON.stringify(posterior)}`,
    );

    const search = await ctx.api("POST", "/api/memory/search", {
      agentId,
      body: { query: `${marker} lighthouse logbook`, limit: 10, scope: "agent" },
    });
    expectStatus(search, [200], "memory search with a net-negative candidate");
    const searched = resultIds(search.json);
    expect(
      searched.includes(rated) && searched.includes(plain),
      `memory search lost the stored memories: got [${searched.join(", ")}]`,
    );

    const list = await ctx.api("POST", "/api/memory/list", {
      agentId,
      body: { query: `${marker} lighthouse logbook`, agentId, limit: 10 },
    });
    expectStatus(list, [200], "memory list with a query and a net-negative candidate");
    const listed = resultIds(list.json);
    expect(
      listed.includes(rated) && listed.includes(plain),
      `memory list lost the stored memories: got [${listed.join(", ")}]`,
    );
  },
};
