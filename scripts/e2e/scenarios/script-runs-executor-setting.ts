import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callToolErr, registerAgent, toolText, upsertScript, withMcp } from "./script-helpers";

const NOOP = "export default async function () { return 1; }";

/** A script whose top level writes `marker`: only a native Bun evaluation can create it. */
function markerSource(marker: string): string {
  return `import { z } from "zod";
await (globalThis as any).Bun.write(${JSON.stringify(marker)}, "evaluated");
export const argsSchema = z.object({ n: z.number() });
export default async function (args: z.infer<typeof argsSchema>) {
  return args.n;
}`;
}

async function savedArgsJsonSchema(
  ctx: ScenarioContext,
  agentId: string,
  name: string,
  source: string,
): Promise<unknown> {
  const saved = await upsertScript(ctx, agentId, { name, source });
  const detail = await ctx.api("GET", `/api/scripts/${saved.id}`);
  expectStatus(detail, [200], `get script ${name}`);
  return asRecord(asRecord(detail.json).script).argsJsonSchema;
}

/**
 * Durable runs only have a native runner, so under SCRIPT_EXECUTOR=quickjs the server refuses
 * new ones (HTTP and MCP) and fails a durable run it would otherwise respawn after a restart.
 * Saving a script under quickjs also must not evaluate its source in native Bun to read
 * `argsSchema`.
 */
export const scriptRunsExecutorSetting: Scenario = {
  name: "script-runs-executor-setting",
  order: 447,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "executor-setting");
    const workerId = await registerAgent(ctx, "executor-setting-worker");

    // A durable run parked on an unclaimed step task survives the restart as `running`.
    const launched = await ctx.api("POST", "/api/script-runs", {
      agentId,
      body: {
        source: `export default async function (args: any, ctx: any) {
  return await ctx.step.agentTask("wait", { task: args.task, agentId: args.workerId });
}`,
        args: { workerId, task: `executor setting ${ctx.nonce}` },
        background: true,
      },
    });
    expectStatus(launched, [201], "launch durable run under native");
    const runId = asString(asRecord(launched.json).id, "durable run id");
    let taskId = "";
    // World-writable so a sandbox child that dropped to nobody can still write the marker.
    const markerDir = mkdtempSync(join(tmpdir(), "e2e-executor-setting-"));
    chmodSync(markerDir, 0o777);
    try {
      // Control: under native, saving evaluates the module and extracts its args schema.
      const nativeMarker = join(markerDir, "native");
      const nativeSchema = asRecord(
        await savedArgsJsonSchema(
          ctx,
          agentId,
          `e2e-executor-schema-native-${ctx.nonce}`,
          markerSource(nativeMarker),
        ),
      );
      expect(
        asRecord(nativeSchema.properties).n !== undefined && existsSync(nativeMarker),
        `native save must extract argsJsonSchema: ${JSON.stringify(nativeSchema).slice(0, 300)}`,
      );

      const waiting = await pollUntil(() => {
        const task = ctx.db.get<{ id: string }>(
          "SELECT id FROM agent_tasks WHERE contextKey = ? AND taskType = 'script-run-step'",
          [`script-run:${runId}:wait`],
        );
        taskId = task?.id ?? "";
        return taskId !== "";
      }, 30_000);
      expect(waiting, `durable run never reached its step task: ${await ctx.sutLog()}`);

      await ctx.restartSut({ env: { SCRIPT_EXECUTOR: "quickjs" } });

      const refused = await ctx.api("POST", "/api/script-runs", {
        agentId,
        body: { source: NOOP, background: true },
      });
      expectStatus(refused, [400], "durable launch under quickjs");
      expect(
        String(asRecord(refused.json).error).includes("SCRIPT_EXECUTOR"),
        `refusal must name the setting: ${JSON.stringify(refused.json)}`,
      );

      const quickjsMarker = join(markerDir, "quickjs");
      const quickjsSchema = await savedArgsJsonSchema(
        ctx,
        agentId,
        `e2e-executor-schema-quickjs-${ctx.nonce}`,
        markerSource(quickjsMarker),
      );
      expect(
        !existsSync(quickjsMarker),
        "saving a script under quickjs must not evaluate its source in native Bun",
      );
      expect(
        quickjsSchema === null,
        `quickjs save stores no argsJsonSchema: ${JSON.stringify(quickjsSchema)}`,
      );
      await withMcp(ctx, agentId, async (mcp) => {
        const result = await callToolErr(mcp, "launch-script-run", { source: NOOP });
        expect(
          toolText(result).includes("SCRIPT_EXECUTOR"),
          `launch-script-run must refuse under quickjs: ${toolText(result).slice(0, 300)}`,
        );
      });

      let run: Record<string, unknown> = {};
      const failed = await pollUntil(async () => {
        const detail = await ctx.api("GET", `/api/script-runs/${runId}`);
        expectStatus(detail, [200], "poll durable run after restart");
        run = asRecord(asRecord(detail.json).run);
        return run.status !== "running";
      }, 30_000);
      expect(
        failed && run.status === "failed" && String(run.error).includes("SCRIPT_EXECUTOR"),
        `restart under quickjs must fail the durable run, not respawn it: ${JSON.stringify(run)}`,
      );
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
      await ctx.api("DELETE", `/api/script-runs/${runId}`);
      if (taskId) await ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: {} });
      // Later scenarios run durable scripts under the default executor.
      await ctx.restartSut();
    }
  },
};
