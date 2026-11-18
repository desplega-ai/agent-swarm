import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

const LINE_MAX_CHARS = 256 * 1024;

async function setBudgetMb(ctx: ScenarioContext, value: string) {
  const upsert = await ctx.api("PUT", "/api/config", {
    body: {
      scope: "global",
      scopeId: null,
      key: "SESSION_LOG_SESSION_MAX_MB",
      value,
      isSecret: false,
    },
  });
  expectStatus(upsert, [200], "set the session log budget");
  expectStatus(await ctx.api("POST", "/api/config/reload"), [200], "reload config into the env");
  return String(asRecord(upsert.json).id);
}

/**
 * Write-time bounds on session_logs: a per-line cap and a per-session byte
 * budget. Retention is age-based, so only these keep one runaway session from
 * filling the disk inside a single day.
 */
export const coreSessionLogBounds: Scenario = {
  name: "core-session-log-bounds",
  order: 247,
  async run(ctx) {
    const oversizedSession = `core-slb-line-${ctx.nonce}`;
    const line = "x".repeat(2 * 1024 * 1024);
    const stored = await ctx.api("POST", "/api/session-logs", {
      body: { sessionId: oversizedSession, iteration: 1, cli: "opencode", lines: [line] },
    });
    expectStatus(stored, [201], "store an oversized line");
    const rows = ctx.db.query<{ content: string }>(
      "SELECT content FROM session_logs WHERE sessionId = ?",
      [oversizedSession],
    );
    expect(rows.length === 1, `Expected 1 stored row, got ${rows.length}`);
    const content = rows[0]?.content ?? "";
    expect(
      content.length < line.length && content.length <= LINE_MAX_CHARS + 200,
      `An oversized line must be truncated to about ${LINE_MAX_CHARS} chars, got ${content.length}`,
    );
    expect(content.includes("[truncated"), "A truncated line must say so");

    const configId = await setBudgetMb(ctx, "1");
    try {
      const budgetSession = `core-slb-budget-${ctx.nonce}`;
      const chunk = "y".repeat(100 * 1024);
      expectStatus(
        await ctx.api("POST", "/api/session-logs", {
          body: {
            sessionId: budgetSession,
            iteration: 1,
            cli: "opencode",
            lines: Array.from({ length: 40 }, () => chunk),
          },
        }),
        [201],
        "store a batch that crosses the budget",
      );
      const written = ctx.db.query<{ content: string }>(
        "SELECT content FROM session_logs WHERE sessionId = ? ORDER BY rowid",
        [budgetSession],
      );
      const bytes = written.reduce((sum, row) => sum + row.content.length, 0);
      expect(
        bytes < 4 * 1024 * 1024,
        `A 1 MB budget must stop well before the 4 MB the batch carries, stored ${bytes}`,
      );
      expect(
        written.at(-1)?.content.includes("session_log_budget_exhausted") === true,
        "The last stored row must be the budget marker",
      );

      expectStatus(
        await ctx.api("POST", "/api/session-logs", {
          body: { sessionId: budgetSession, iteration: 1, cli: "opencode", lines: ["after"] },
        }),
        [201],
        "post again after the budget is spent",
      );
      const after = ctx.db.query<{ content: string }>(
        "SELECT content FROM session_logs WHERE sessionId = ?",
        [budgetSession],
      );
      expect(
        after.length === written.length,
        `An exhausted session must store nothing more, went from ${written.length} to ${after.length} rows`,
      );

      // The accounting lives in SQLite, so a restart must not hand the same
      // session a second budget.
      await ctx.restartSut({ env: { SESSION_LOG_SESSION_MAX_MB: "1" } });
      expectStatus(
        await ctx.api("POST", "/api/session-logs", {
          body: {
            sessionId: budgetSession,
            iteration: 1,
            cli: "opencode",
            lines: Array.from({ length: 10 }, () => chunk),
          },
        }),
        [201],
        "post after an API restart",
      );
      const afterRestart = ctx.db.query<{ content: string }>(
        "SELECT content FROM session_logs WHERE sessionId = ?",
        [budgetSession],
      );
      expect(
        afterRestart.length === written.length,
        `A restart must not grant a second budget, went from ${written.length} to ${afterRestart.length} rows`,
      );

      // The budget counts UTF-8 bytes: 3-byte characters must spend it ~3x
      // faster than `String.length` would suggest.
      const cjkSession = `core-slb-utf8-${ctx.nonce}`;
      expectStatus(
        await ctx.api("POST", "/api/session-logs", {
          body: {
            sessionId: cjkSession,
            iteration: 1,
            cli: "opencode",
            lines: Array.from({ length: 20 }, () => "漢".repeat(100 * 1024)),
          },
        }),
        [201],
        "store CJK lines",
      );
      const cjkBytes = ctx.db.get<{ bytes: number }>(
        "SELECT sum(octet_length(content)) AS bytes FROM session_logs WHERE sessionId = ?",
        [cjkSession],
      );
      expect(
        (cjkBytes?.bytes ?? 0) <= 2 * 1024 * 1024,
        `A 1 MB budget must bound stored UTF-8 bytes, stored ${cjkBytes?.bytes ?? 0}`,
      );
    } finally {
      expectStatus(
        await ctx.api("DELETE", `/api/config/${configId}`),
        [200],
        "restore the default budget",
      );
      expectStatus(await ctx.api("POST", "/api/config/reload"), [200], "reload after restore");
    }
  },
};
