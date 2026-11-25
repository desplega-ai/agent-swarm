import { insertionOrder, sql } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { asUser, createAssignedTask, createUser, registerWorker } from "./core-helpers";

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
    // Bounds apply to every repeated metadata field, not only content/sessionId.
    for (const field of ["sessionId", "taskId", "cli"]) {
      expectStatus(
        await ctx.api("POST", "/api/session-logs", {
          body: {
            sessionId: `metadata-${ctx.nonce}`,
            iteration: 1,
            lines: ["x"],
            [field]: "m".repeat(1024),
          },
        }),
        [400],
        `reject oversized ${field}`,
      );
    }
    const oversizedSession = `core-slb-line-${ctx.nonce}`;
    const line = "x".repeat(2 * 1024 * 1024);
    const stored = await ctx.api("POST", "/api/session-logs", {
      body: { sessionId: oversizedSession, iteration: 1, cli: "opencode", lines: [line] },
    });
    expectStatus(stored, [201], "store an oversized line");
    const rows = ctx.db.query<{ content: string }>(
      sql`SELECT content FROM session_logs WHERE "sessionId" = ${oversizedSession}`,
    );
    expect(rows.length === 1, `Expected 1 stored row, got ${rows.length}`);
    const content = rows[0]?.content ?? "";
    expect(
      content.length < line.length && content.length <= LINE_MAX_CHARS + 200,
      `An oversized line must be truncated to about ${LINE_MAX_CHARS} chars, got ${content.length}`,
    );
    expect(content.includes("[truncated"), "A truncated line must say so");

    // A JSONL event is every other harness's log format: cutting it would
    // leave the row unparseable and the dashboard would render a parse error.
    const jsonSession = `core-slb-json-${ctx.nonce}`;
    expectStatus(
      await ctx.api("POST", "/api/session-logs", {
        body: {
          sessionId: jsonSession,
          iteration: 1,
          cli: "claude",
          lines: [JSON.stringify({ type: "tool_result", content: "z".repeat(2 * 1024 * 1024) })],
        },
      }),
      [201],
      "store an oversized JSON event",
    );
    const jsonRow =
      ctx.db.get<{ content: string }>(
        sql`SELECT content FROM session_logs WHERE "sessionId" = ${jsonSession}`,
      )?.content ?? "";
    expect(
      (() => {
        try {
          JSON.parse(jsonRow);
          return true;
        } catch {
          return false;
        }
      })(),
      `A truncated JSON event must stay parseable, stored ${jsonRow.slice(0, 120)}`,
    );

    const configId = await setBudgetMb(ctx, "1");
    try {
      const workerId = await registerWorker(ctx, "log-budget-owner");
      const owner = await createUser(ctx, "log-budget-owner");
      const stranger = await createUser(ctx, "log-budget-stranger");
      const ownerTask = await createAssignedTask(ctx, workerId, `log owner ${ctx.nonce}`, {
        requestedByUserId: owner,
      });
      const otherTask = await createAssignedTask(ctx, workerId, `log other ${ctx.nonce}`, {
        requestedByUserId: stranger,
      });
      const protectedSession = `protected-${ctx.nonce}`;
      const flood = Array.from({ length: 40 }, () => "f".repeat(100 * 1024));
      for (const taskId of [undefined, ownerTask]) {
        expectStatus(
          await ctx.api("POST", "/api/session-logs", {
            headers: asUser(stranger),
            body: { sessionId: protectedSession, taskId, iteration: 1, lines: flood },
          }),
          [403],
          "stranger cannot spend the victim's log budget",
        );
      }
      // Even with write access to another task, spoofing sessionId spends only
      // that task's account, never the victim's.
      expectStatus(
        await ctx.api("POST", "/api/session-logs", {
          headers: asUser(stranger),
          body: { sessionId: protectedSession, taskId: otherTask, iteration: 1, lines: flood },
        }),
        [201],
        "another writable task has an isolated budget",
      );
      const tokenResponse = await ctx.api("POST", "/api/sessions/tokens", {
        body: { agentId: workerId, runtimeId: `log-worker-${ctx.nonce}` },
      });
      expectStatus(tokenResponse, [200], "mint pool-worker runtime credential");
      const workerCredential = asRecord(tokenResponse.json);
      try {
        expectStatus(
          await ctx.api("POST", "/api/session-logs", {
            apiKey: String(workerCredential.plaintext),
            body: { sessionId: protectedSession, iteration: 1, lines: flood },
          }),
          [201],
          "pre-claim worker uploads retain a separate budget",
        );
      } finally {
        expectStatus(
          await ctx.api("DELETE", `/api/sessions/tokens/${workerCredential.tokenId}`),
          [204],
          "revoke pool-worker runtime credential",
        );
      }
      const ownerUpload = await ctx.api("POST", "/api/session-logs", {
        headers: asUser(owner),
        body: {
          sessionId: protectedSession,
          taskId: ownerTask,
          iteration: 1,
          lines: ["owner-survives"],
        },
      });
      expectStatus(ownerUpload, [201], "owner logs after spoofed-session flood");
      expect(
        asRecord(ownerUpload.json).count === 1,
        "A foreign task must not exhaust the owner's budget",
      );
      const ownerRows = ctx.db.query<{ content: string }>(
        sql`SELECT content FROM session_logs WHERE "taskId" = ${ownerTask} AND "sessionId" = ${protectedSession}`,
      );
      expect(
        ownerRows.some((row) => row.content === "owner-survives"),
        "Owner transcript remains writable",
      );
      const outsiderWorker = await registerWorker(ctx, "log-budget-outsider");
      const outsiderToken = await ctx.api("POST", "/api/sessions/tokens", {
        body: { agentId: outsiderWorker, runtimeId: `log-outsider-${ctx.nonce}` },
      });
      expectStatus(outsiderToken, [200], "mint another worker's runtime credential");
      const outsiderCredential = asRecord(outsiderToken.json);
      try {
        expectStatus(
          await ctx.api("POST", "/api/session-logs", {
            apiKey: String(outsiderCredential.plaintext),
            body: { sessionId: protectedSession, taskId: ownerTask, iteration: 1, lines: flood },
          }),
          [403],
          "another worker cannot spend the assigned task's budget",
        );
      } finally {
        expectStatus(
          await ctx.api("DELETE", `/api/sessions/tokens/${outsiderCredential.tokenId}`),
          [204],
          "revoke another worker's runtime credential",
        );
      }

      const budgetSession = `core-slb-budget-${ctx.nonce}`;
      const chunk = "y".repeat(100 * 1024);
      const crossing = await ctx.api("POST", "/api/session-logs", {
        body: {
          sessionId: budgetSession,
          iteration: 1,
          cli: "opencode",
          lines: Array.from({ length: 40 }, () => chunk),
        },
      });
      expectStatus(crossing, [201], "store a batch that crosses the budget");
      // The response reports what was stored, not what was posted.
      const reported = asRecord(crossing.json).count;
      expect(
        typeof reported === "number" && reported < 40,
        `A truncated batch must report fewer than the 40 posted lines, got ${String(reported)}`,
      );
      const written = ctx.db.query<{ content: string }>(
        sql`SELECT content FROM session_logs WHERE "sessionId" = ${budgetSession} ORDER BY ${insertionOrder}`,
      );
      const bytes =
        ctx.db.get<{ bytes: number }>(
          sql`SELECT sum(octet_length(content)) AS bytes FROM session_logs WHERE "sessionId" = ${budgetSession}`,
        )?.bytes ?? 0;
      // The marker is the only row allowed past the bound.
      expect(
        bytes <= 1024 * 1024 + 1024,
        `A 1 MB budget must bound the stored bytes, stored ${bytes}`,
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
        sql`SELECT content FROM session_logs WHERE "sessionId" = ${budgetSession}`,
      );
      expect(
        after.length === written.length,
        `An exhausted session must store nothing more, went from ${written.length} to ${after.length} rows`,
      );

      // Overlapping uploads must reserve their bytes against each other, not
      // each spend the same remaining budget.
      const raceSession = `core-slb-race-${ctx.nonce}`;
      // Each upload crosses the 200-row write-batch boundary. Both writers
      // must reload the committed spend after yielding between their batches.
      const raceResponses = await Promise.all(
        Array.from({ length: 2 }, () =>
          ctx.api("POST", "/api/session-logs", {
            body: {
              sessionId: raceSession,
              iteration: 1,
              cli: "opencode",
              lines: Array.from({ length: 400 }, () => "r".repeat(3_000)),
            },
          }),
        ),
      );
      for (const response of raceResponses) {
        expectStatus(response, [201], "overlapping multi-batch upload");
      }
      const raceBytes =
        ctx.db.get<{ bytes: number }>(
          sql`SELECT sum(octet_length(content)) AS bytes FROM session_logs WHERE "sessionId" = ${raceSession}`,
        )?.bytes ?? 0;
      expect(
        raceBytes <= 1024 * 1024 + 1024,
        `Concurrent batches must share one budget, stored ${raceBytes}`,
      );
      const markers = ctx.db.query<{ content: string }>(
        sql`SELECT content FROM session_logs WHERE "sessionId" = ${raceSession} AND content LIKE '%session_log_budget_exhausted%'`,
      );
      expect(
        markers.length === 1,
        `Overlapping batches must agree on one exhaustion, got ${markers.length} markers`,
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
        sql`SELECT content FROM session_logs WHERE "sessionId" = ${budgetSession}`,
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
        sql`SELECT sum(octet_length(content)) AS bytes FROM session_logs WHERE "sessionId" = ${cjkSession}`,
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
