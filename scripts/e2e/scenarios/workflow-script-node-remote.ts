import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

async function runNode(
  ctx: ScenarioContext,
  config: Record<string, unknown>,
  cancel = false,
  onTriggered?: (runId: string) => Promise<void>,
  followField?: string,
) {
  const created = await ctx.api("POST", "/api/workflows", {
    body: {
      name: `shell-parity-${ctx.nonce}-${crypto.randomUUID()}`,
      definition: {
        nodes: [
          { id: "shell", type: "script", config, ...(followField ? { next: "follow" } : {}) },
          ...(followField
            ? [
                {
                  id: "follow",
                  type: "script",
                  inputs: { value: `shell.${followField}` },
                  config: {
                    runtime: "ts",
                    script: "console.log(process.env.VALUE)",
                    env: { VALUE: "{{value}}" },
                  },
                },
              ]
            : []),
        ],
      },
    },
  });
  expectStatus(created, [201], "create shell workflow");
  const id = asString(asRecord(created.json).id, "workflow id");
  const started = await ctx.api("POST", `/api/workflows/${id}/trigger`, { body: {} });
  expectStatus(started, [201], "trigger shell workflow");
  const runId = asString(asRecord(started.json).runId, "run id");
  await onTriggered?.(runId);
  if (cancel) {
    expect(
      await pollUntil(
        async () =>
          asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions").some(
            (runner) => Number(runner.jobsInFlight) > 0,
          ),
        15000,
      ),
      "cancellable shell reaches runner",
    );
    expectStatus(
      await ctx.api("POST", `/api/workflow-runs/${runId}/cancel`, {
        body: { reason: "synthetic cancellation" },
      }),
      [200],
      "cancel shell workflow",
    );
  }
  let detail: Record<string, unknown> = {};
  expect(
    await pollUntil(async () => {
      detail = asRecord((await ctx.api("GET", `/api/workflow-runs/${runId}`)).json);
      return ["completed", "failed", "cancelled"].includes(String(asRecord(detail.run).status));
    }, 60_000),
    "shell workflow became terminal",
  );
  const step = asRecords(detail, "steps").find((step) => step.nodeId === "shell");
  expect(step, "shell step exists");
  return {
    run: asRecord(detail.run),
    step,
    output: step.output == null ? {} : asRecord(step.output),
    followOutput: asRecords(detail, "steps").find((step) => step.nodeId === "follow")?.output,
  };
}

export const workflowScriptNodeRemote: Scenario = {
  name: "workflow-script-node-remote",
  order: 61,
  async run(ctx) {
    if (ctx.db.engine !== "postgres") return;
    const marker = `shell-${ctx.nonce}`;
    const configs = [
      {
        runtime: "bash",
        script: 'printf \'{"marker":"%s","hostname":"%s"}\\n\' "$MARKER" "$(hostname)"',
        env: { MARKER: marker },
      },
      {
        runtime: "ts",
        script:
          'console.log(JSON.stringify({marker:process.env.MARKER,hostname:require("node:os").hostname()}))',
        env: { MARKER: marker },
      },
      ...(Bun.which("python3")
        ? [
            {
              runtime: "python",
              script:
                "import json,os,socket; print(json.dumps({'marker':os.environ['MARKER'],'hostname':socket.gethostname()}))",
              env: { MARKER: marker },
            },
          ]
        : []),
    ];
    const baseline = [];
    for (const config of configs) {
      const result = await runNode(ctx, config);
      expect(
        result.run.status === "completed",
        `embedded ${config.runtime} shell completes: ${JSON.stringify(result.step)}`,
      );
      expect(result.output.marker === marker, "embedded JSON fields remain available");
      expect(
        typeof result.output.hostname === "string" && result.output.hostname.length > 0,
        "shell reports hostname",
      );
      baseline.push(result.output);
    }
    const ordinary = await runNode(
      ctx,
      {
        runtime: "ts",
        script: 'console.log(JSON.stringify({token:"ordinary",marker:"preserved"}))',
        cwd: "",
      },
      false,
      undefined,
      "token",
    );
    expect(
      ordinary.run.status === "completed" && asRecord(ordinary.followOutput).stdout === "ordinary",
      "awaited shell preserves ordinary field values for downstream nodes",
    );
    const minted = await ctx.api("POST", "/api/script-runners/credentials", {
      body: { name: `shell-${ctx.nonce}` },
    });
    expectStatus(minted, [201], "mint shell runner credential");
    const credentialId = asString(asRecord(asRecord(minted.json).credential).id, "credential id");
    const runner = ctx.startScriptRunner(asString(asRecord(minted.json).token, "token"));
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "phase10-cwd-")));
    const sessions = async () =>
      asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions");
    try {
      expect(
        await pollUntil(async () => (await sessions()).length === 1, 15000),
        "shell runner connects",
      );
      const before = Number((await sessions())[0]?.jobsCompleted ?? 0);
      for (let i = 0; i < configs.length; i++) {
        const result = await runNode(ctx, configs[i]!);
        expect(
          result.run.status === "completed",
          `remote shell completes: ${JSON.stringify(result.step)}`,
        );
        expect(
          Bun.deepEquals(result.output, baseline[i]),
          "remote shell output matches embedded output",
        );
      }
      expect(
        await pollUntil(
          async () => Number((await sessions())[0]?.jobsCompleted) === before + configs.length,
          5000,
        ),
        "all shell nodes use remote runner",
      );
      const pinned = await runNode(ctx, {
        runtime: "ts",
        script: "console.log(JSON.stringify({cwd:process.cwd()}))",
        cwd,
      });
      expect(pinned.run.status === "completed", "cwd node completes locally");
      expect(pinned.output.cwd === cwd, "cwd node uses API directory");
      expect(
        Number((await sessions())[0]?.jobsCompleted) === before + configs.length,
        "cwd node consumes no remote slot",
      );

      const remoteOrdinary = await runNode(
        ctx,
        {
          runtime: "ts",
          script: 'console.log(JSON.stringify({token:"ordinary",marker:"preserved"}))',
          cwd: "",
        },
        false,
        undefined,
        "token",
      );
      expect(
        remoteOrdinary.run.status === "completed" &&
          asRecord(remoteOrdinary.followOutput).stdout === "ordinary",
        "remote shell preserves ordinary field values for downstream nodes",
      );

      const failed = await runNode(ctx, {
        runtime: "bash",
        script: "printf synthetic-failure >&2; exit 7",
      });
      expect(
        failed.run.status === "failed" && failed.step.error === "synthetic-failure",
        "nonzero shell preserves exact failure error",
      );
      const timedOut = await runNode(ctx, {
        runtime: "bash",
        script: "sleep 30",
        timeout: 1000,
      });
      expect(
        timedOut.run.status === "failed" &&
          timedOut.step.error === "Script execution error: Script timed out after 1000ms" &&
          timedOut.output.stderr === "Script timed out after 1000ms",
        "remote shell preserves exact timeout failure",
      );
      const secret = `ghp_${"a".repeat(36)}`;
      const scrubbed = await runNode(ctx, {
        runtime: "ts",
        script: 'console.log(JSON.stringify({marker:"visible",value:process.env.SYNTHETIC_VALUE}))',
        env: { SYNTHETIC_VALUE: secret },
      });
      expect(
        scrubbed.run.status === "completed" && scrubbed.output.marker === "visible",
        "scrubbing preserves ordinary output",
      );
      expect(
        !JSON.stringify(scrubbed.output).includes(secret),
        "API scrubs synthetic secret before JSON mapping",
      );
      const cancelled = await runNode(ctx, { runtime: "bash", script: "sleep 30" }, true);
      expect(cancelled.run.status === "cancelled", "shell cancellation settles run");
      expect(
        await pollUntil(
          async () => (await sessions()).every((runner) => Number(runner.jobsInFlight) === 0),
          10000,
        ),
        "cancellation releases held runner slot",
      );
    } finally {
      await runner.stop();
      await rm(cwd, { recursive: true, force: true });
      await ctx.api("DELETE", `/api/script-runners/credentials/${credentialId}`);
    }
    await ctx.restartSut({ env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0" } });
    const limited = await ctx.api("POST", "/api/script-runners/credentials", {
      body: { name: `missing-runtime-${ctx.nonce}` },
    });
    expectStatus(limited, [201], "mint limited runner credential");
    let socket: WebSocket | undefined;
    try {
      const missing = await runNode(
        ctx,
        { runtime: "ts", script: "console.log('synthetic')" },
        false,
        async (runId) => {
          expect(
            await pollUntil(
              async () =>
                asRecord(asRecord((await ctx.api("GET", `/api/workflow-runs/${runId}`)).json).run)
                  .status === "waiting",
              10000,
            ),
            "shell parks before a runner connects",
          );
          socket = new WebSocket(
            `${ctx.baseUrl.replace(/^http/, "ws")}/api/script-runners/connect`,
            {
              headers: { Authorization: `Bearer ${asRecord(limited.json).token}` },
            },
          );
          socket!.on("error", () => {});
          socket!.on("open", () =>
            socket!.send(
              JSON.stringify({
                type: "hello",
                instanceId: crypto.randomUUID(),
                version: 1,
                slots: 1,
                executors: ["native"],
                runtimes: [],
                stepJobs: true,
                held: [],
              }),
            ),
          );

          expect(
            await pollUntil(async () => (await sessions()).length === 1, 15000),
            "limited runner connects after park",
          );
        },
      );
      expect(missing.run.status === "failed", "missing runtime fails without waiting for a slot");
      expect(
        missing.step.error === "No connected runner supports this workflow job",
        "missing runtime error explains the cause",
      );
      const pinned = await runNode(ctx, {
        runtime: "ts",
        script: "console.log('synthetic')",
        cwd: "/tmp",
      });
      expect(pinned.run.status === "failed", "cwd fails when embedded runner is disabled");
      expect(
        pinned.step.error === "A workflow script with cwd requires the embedded runner",
        "cwd failure explains local requirement",
      );
    } finally {
      socket?.terminate();
      await ctx.api(
        "DELETE",
        `/api/script-runners/credentials/${asRecord(asRecord(limited.json).credential).id}`,
      );
      await ctx.restartSut();
    }
  },
};
