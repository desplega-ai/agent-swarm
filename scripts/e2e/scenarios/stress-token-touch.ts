import { sql } from "../db";
import { asRecord, expect } from "../http";
import type { Scenario } from "../run";
import { expectRunOk, registerAgent, runScript } from "./script-helpers";

const CALLS_PER_BURST = 150;
const IN_FLIGHT = 16;
const GAP_MS = 1_500;
/**
 * Postgres rollbacks the two bursts may add, whatever else the API runs at the
 * same time. Before the fix, every call wrote the token row, and on Postgres
 * (SERIALIZABLE) most parallel writes of one row fail with 40001 and roll back:
 * one burst alone added far more than this.
 */
const MAX_ROLLBACKS = 30;

// One script run makes many SDK calls at the same time. Each call authenticates
// with the run's one session token. Two bursts of parallel calls, with a gap
// between them, show that a token's `lastUsedAt` is written at most once per
// interval (it keeps the time of the first burst) and that the parallel calls do
// not race on the token row: on Postgres they add almost no rollbacks. The run
// still revokes its token at the end.
const BURST_SCRIPT = `export default async function (args: { key: string; calls: number; inFlight: number; gapMs: number }, ctx: any) {
  let failed = 0;
  const burst = async () => {
    let next = 0;
    await Promise.all(Array.from({ length: args.inFlight }, async () => {
      while (next < args.calls) {
        next += 1;
        try {
          await ctx.swarm.kv_getOrNull({ key: args.key });
        } catch {
          failed += 1;
        }
      }
    }));
  };
  const firstAt = new Date().toISOString();
  await burst();
  await new Promise((resolve) => setTimeout(resolve, args.gapMs));
  const secondAt = new Date().toISOString();
  await burst();
  return { firstAt, secondAt, failed };
}`;

type TokenRow = { lastUsedAt: string | null; revokedAt: string | null; scriptRun: number };

export const stressTokenTouch: Scenario = {
  name: "stress-token-touch",
  order: 9_447,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "token-touch");
    const rollbacks = () =>
      Number(
        ctx.db.get<{ n: number }>(
          "SELECT xact_rollback AS n FROM pg_stat_database WHERE datname = current_database()",
        )?.n,
      );
    const rollbacksBefore = ctx.db.engine === "postgres" ? rollbacks() : 0;

    const run = await runScript(ctx, agentId, {
      source: BURST_SCRIPT,
      args: {
        key: `token-touch-${ctx.nonce}`,
        calls: CALLS_PER_BURST,
        inFlight: IN_FLIGHT,
        gapMs: GAP_MS,
      },
      intent: `e2e token touch ${ctx.nonce}`,
    });
    // Read the counter first: the checks below can fail before it.
    const added = ctx.db.engine === "postgres" ? rollbacks() - rollbacksBefore : 0;
    if (ctx.db.engine === "postgres") {
      ctx.log(`token touch: ${2 * CALLS_PER_BURST} calls, ${added} Postgres rollbacks`);
    }
    expectRunOk(run, "parallel SDK calls with one run token");
    expect(
      added <= MAX_ROLLBACKS,
      `${2 * CALLS_PER_BURST} parallel calls with one token added ${added} Postgres rollbacks (bound ${MAX_ROLLBACKS})`,
    );
    const result = asRecord(run.result);
    expect(result.failed === 0, `${String(result.failed)} SDK calls failed`);
    const secondAt = Date.parse(String(result.secondAt));
    expect(Number.isFinite(secondAt), `no second burst time: ${JSON.stringify(result)}`);

    const tokens = ctx.db
      .query<TokenRow>(
        sql`SELECT "lastUsedAt", "revokedAt", "scriptRun" FROM session_tokens WHERE "agentId" = ${agentId}`,
      )
      .filter((row) => Number(row.scriptRun) === 1);
    expect(tokens.length === 1, `expected one script-run token, found ${tokens.length}`);
    const token = tokens[0] as TokenRow;
    expect(token.revokedAt !== null, "the run must revoke its token when it ends");
    expect(token.lastUsedAt !== null, "using the token must stamp lastUsedAt");
    const lastUsedAt = Date.parse(String(token.lastUsedAt));
    expect(
      lastUsedAt < secondAt,
      `lastUsedAt ${token.lastUsedAt} moved to the second burst (${String(result.secondAt)}): ` +
        "every call wrote the token row",
    );
  },
};
