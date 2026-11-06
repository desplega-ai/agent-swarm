import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createSessionCost,
  getDbClient,
  initDb,
} from "../be/db";
import { emptyFacts } from "../be/savings/compute";
import { readFleetSavings, resetSavingsReadCache } from "../be/savings/read";
import {
  resetSavingsRollupForTests,
  utcDay,
  writeScriptDay,
  writeWorkflowDay,
} from "../be/savings/rollup";
import { handleSavings } from "../http/savings";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

// The routes read the clock, so the fixtures sit on the real last 7 UTC days.
const NOW = Date.now();
const WEEK = Array.from({ length: 7 }, (_, i) => utcDay(NOW - (6 - i) * 86_400_000));

describe("savings fleet read", () => {
  let server: Server;
  let port: number;
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    initDb(":memory:");
    await resetSavingsRollupForTests();
    server = createHttpServer(async (req, res) => {
      const handled = await handleSavings(
        req,
        res,
        getPathSegments(req.url || ""),
        parseQueryParams(req.url || ""),
      );
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    port = await listenOnFreePort(server);
  });

  afterAll(async () => {
    server?.close();
    closeDb();
  });

  test("an empty DB is not valid, never $0", async () => {
    const read = await readFleetSavings({ days: 7, tier: "smart", now: NOW });
    expect(read).toMatchObject({ complete: false, total: null, points: [] });
    const { status, body } = await get("/api/savings/summary?days=7");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      valid: false,
      reason: "not-computed",
      total: null,
      byKind: null,
      selfOptimizationRatio: null,
    });
    expect(body.assumptions.length).toBeGreaterThan(0);
    const daily = await get("/api/savings/daily?days=7");
    expect(daily.body).toMatchObject({ valid: false, points: [] });
  });

  test("computed days with no runs are valid-less with reason no-runs", async () => {
    const at = new Date(NOW).toISOString();
    for (const day of WEEK) {
      await writeWorkflowDay(day, [], at);
      await writeScriptDay(day, [], at);
    }
    const { body } = await get("/api/savings/summary?days=7");
    expect(body).toMatchObject({ valid: false, reason: "no-runs", total: null });
  });

  describe("with workflows and scripts", () => {
    beforeAll(async () => {
      const at = new Date(NOW).toISOString();
      await createScheduledTask({
        name: "fleet-poll-hourly",
        intervalMs: 3_600_000,
        targetType: "script",
        scriptName: "fleet-poll",
      });
      for (const day of WEEK) {
        const a = { ...emptyFacts(10), countedRuns: 10, opsSum: 100, computeSecs: 20 };
        const b = { ...emptyFacts(4), countedRuns: 4, opsSum: 8, agentUsd: 0.4, agentTasks: 1 };
        await writeWorkflowDay(
          day,
          [
            { workflowId: "wf-a", name: "fleet-a", facts: a },
            { workflowId: "wf-b", name: "fleet-b", facts: b },
          ],
          at,
        );
        const script = { runs: 30, apiRuns: 0, effectRuns: 0, apiEffectRuns: 0, computeSecs: 60 };
        await writeScriptDay(
          day,
          [
            { scriptName: "fleet-poll", facts: { ...script, opsSum: 30 * 12 } },
            { scriptName: "fleet-helper", facts: { ...script, runs: 5, opsSum: 5 * 20 } },
          ],
          at,
        );
      }
      const agentId = (await createAgent({ name: "fleet-agent", isLead: false, status: "idle" }))
        .id;
      await createSessionCost({
        sessionId: crypto.randomUUID(),
        agentId,
        totalCostUsd: 100,
        durationMs: 60_000,
        numTurns: 3,
        model: "claude-opus-5-5",
      });
    });

    test("the total sums the rows' p50 with the fleet band; the points sum to it", async () => {
      const read = await readFleetSavings({ days: 7, tier: "smart", now: NOW });
      expect(read.complete).toBe(true);
      const rows = [...read.workflows, ...read.scripts];
      expect(rows).toHaveLength(4);
      const p50 = rows.reduce((s, r) => s + r.savingUsd.p50, 0);
      const total = read.total;
      expect(total?.savingUsd.p50).toBeCloseTo(p50, 6);
      // The fleet band is narrower than the sum of the rows' single-job bands.
      expect(total?.savingUsd.p90).toBeLessThan(rows.reduce((s, r) => s + r.savingUsd.p90, 0));
      expect(total?.savingUsd.p10).toBeGreaterThan(rows.reduce((s, r) => s + r.savingUsd.p10, 0));
      expect(read.points).toHaveLength(7);
      expect(read.points.reduce((s, p) => s + p.savingUsd, 0)).toBeCloseTo(p50, 6);
      expect(read.byKind.workflows.jobs).toBe(2);
      expect(read.byKind.scheduledScripts).toMatchObject({ jobs: 1, substitutedRuns: 168 });
      expect(read.byKind.agentInvokedScripts.jobs).toBe(1);
      const kinds = read.byKind;
      expect(
        kinds.workflows.savingUsd +
          kinds.scheduledScripts.savingUsd +
          kinds.agentInvokedScripts.savingUsd,
      ).toBeCloseTo(p50, 6);
    });

    test("the summary and fleet daily routes agree to the cent", async () => {
      const { status, body } = await get("/api/savings/summary?days=7&tier=smol");
      expect(status).toBe(200);
      expect(body).toMatchObject({ valid: true, reason: null, tier: "smol", fleetLlmUsd: 100 });
      expect(body.selfOptimizationRatio).toBeCloseTo((100 + body.total.savingUsd.p50) / 100, 2);
      expect(body.excluded.enabledOnlyRuns).toBe(body.total.runs - body.total.substitutedRuns);
      const daily = await get("/api/savings/daily?days=7&tier=smol");
      expect(daily.body.valid).toBe(true);
      const cents = Math.round(
        daily.body.points.reduce((s: number, p: { savingUsd: number }) => s + p.savingUsd, 0) * 100,
      );
      expect(cents).toBe(Math.round(body.total.savingUsd.p50 * 100));
      const both = await get("/api/savings/daily?workflowId=wf-a&scriptName=fleet-poll");
      expect(both.status).toBe(400);
    });

    test("one job alone keeps the single-job band", async () => {
      await getDbClient().run(
        "DELETE FROM automation_savings_daily WHERE jobId IN ('wf-b','fleet-poll','fleet-helper')",
      );
      // A raw write skips the rollup's generation bump.
      resetSavingsReadCache();
      const read = await readFleetSavings({ days: 7, tier: "smart", now: NOW });
      const [row] = read.workflows;
      expect(read.scripts).toHaveLength(0);
      expect(read.total?.savingUsd).toEqual(row?.savingUsd);
    });
  });
});
