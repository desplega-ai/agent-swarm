import { sql } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { expectRunOk, registerAgent, runScript } from "./script-helpers";

const QUICKJS_IMPORT_ERROR = "is not available to the quickjs executor";

/**
 * Flow `script-input-handling`:
 * - The quickjs executor bundles only the approved imports. A relative or absolute import
 *   fails the build, and the run returns a BuildError. Scripts that import zod, stdlib and
 *   swarm-sdk still run.
 * - The seeded `memory-eval` script keeps only history points with a YYYY-MM-DD date and
 *   escapes the history JSON inside the dashboard's inline script.
 */
export const scriptInputHandling: Scenario = {
  name: "script-input-handling",
  order: 497,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "inputs");

    // ── quickjs: imports outside the approved modules fail the build ───────────────────
    for (const [label, source] of [
      [
        "relative text import",
        'import s from "../etc/hosts" with { type: "text" };\nexport default async () => s;',
      ],
      ["relative re-export", 'export * from "../etc/hosts";\nexport default async () => 1;'],
      [
        "dynamic relative import",
        'export default async () => (await import("../etc/hosts")).default;',
      ],
    ] as const) {
      const run = await runScript(ctx, agentId, { source, executor: "quickjs" }, label);
      const runtimeError = run.runtimeError === undefined ? {} : asRecord(run.runtimeError);
      expect(
        run.exitCode === 1 && run.error === "eval_error" && runtimeError.name === "BuildError",
        // Status fields only: on a regression the result holds file contents.
        `${label}: expected a BuildError, got exitCode=${String(run.exitCode)} error=${String(run.error)} runtimeError=${String(runtimeError.name)}`,
      );
      expect(
        String(runtimeError.message).includes(QUICKJS_IMPORT_ERROR),
        `${label}: unexpected build message ${String(runtimeError.message).slice(0, 300)}`,
      );
      expect(run.result === undefined, `${label}: the run returned a result`);
    }

    // ── quickjs: the approved imports still bundle and run ─────────────────────────────
    const approved = await runScript(
      ctx,
      agentId,
      {
        source: `import { z } from "zod";
import { table } from "stdlib";
import { createSwarmSdk } from "swarm-sdk";
export default async (args: { name: string }) => ({
  name: z.string().min(1).parse(args.name),
  hasTable: typeof table === "function",
  hasSdk: typeof createSwarmSdk === "function",
});`,
        args: { name: `n-${ctx.nonce}` },
        executor: "quickjs",
      },
      "quickjs approved imports",
    );
    expectRunOk(approved, "quickjs approved imports");
    const approvedResult = asRecord(approved.result);
    expect(
      approvedResult.name === `n-${ctx.nonce}` &&
        approvedResult.hasTable === true &&
        approvedResult.hasSdk === true,
      `quickjs approved imports: unexpected result ${JSON.stringify(approvedResult)}`,
    );

    // ── memory-eval: stored history is validated and escaped in the page ──────────────
    const marker = `m${ctx.nonce}`;
    const closingTag = `</script><p id="${marker}">`;
    const keptPoint = {
      date: "2000-01-02",
      axis1Score: 1,
      axis1Total: 1,
      axis1Hits: 1,
      axis2AvgUsefulness: null,
      axis2Retrievals: null,
      axis2PrefCount: null,
      axis3FreshScore: 0,
      axis3TotalRetrieved: 0,
      axis3ExpiredPct: 0,
      totalMemories: 0,
      searchableMemories: 0,
      expiredMemories: 0,
      backfilled: true,
      note: closingTag,
    };
    const droppedPoint = { ...keptPoint, date: `2000-01-03${closingTag}`, note: "dropped" };
    const seeded = await ctx.api("PUT", "/api/kv/_/memory-eval/history", {
      agentId,
      body: { value: [keptPoint, droppedPoint] },
    });
    expectStatus(seeded, [200], "seed memory-eval history");

    try {
      const run = await runScript(
        ctx,
        agentId,
        { name: "memory-eval", args: { backfillDays: 0, publishPage: true } },
        "run memory-eval",
      );
      expectRunOk(run, "memory-eval");
      const report = asRecord(run.result);
      expect(report.historyPoints === 2, `memory-eval kept ${String(report.historyPoints)} points`);
      const pageId = asRecord(report.page).id;
      expect(
        typeof pageId === "string",
        `memory-eval published no page: ${JSON.stringify(report.pageError)}`,
      );

      const page = ctx.db.get<{ body: string }>(
        sql`SELECT body FROM pages WHERE id = ${String(pageId)}`,
      );
      const body = page?.body ?? "";
      expect(body.includes("var H = ["), "memory-eval page has no history data");
      expect(!body.includes(closingTag), "memory-eval page holds an unescaped closing script tag");
      expect(
        body.includes(`\\u003c/script>\\u003cp id=\\"${marker}\\">`),
        "memory-eval page does not hold the escaped history value",
      );
      expect(!body.includes("dropped"), "memory-eval page holds the point with an invalid date");

      const stored = await ctx.api("GET", "/api/kv/_/memory-eval/history", { agentId });
      expectStatus(stored, [200], "read memory-eval history");
      const history = asRecord(stored.json).value;
      expect(Array.isArray(history), "memory-eval history is not an array");
      const dates = (history as unknown[]).map((point) => asRecord(point).date);
      expect(
        dates.length === 2 &&
          dates[0] === "2000-01-02" &&
          /^\d{4}-\d{2}-\d{2}$/.test(String(dates[1])),
        `memory-eval history dates ${JSON.stringify(dates)}`,
      );
    } finally {
      await ctx.api("DELETE", "/api/kv/_/memory-eval/history", { agentId });
    }
  },
};
