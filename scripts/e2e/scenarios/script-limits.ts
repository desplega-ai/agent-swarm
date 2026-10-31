import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { expectRunOk, registerAgent, runScript, upsertScript } from "./script-helpers";

const STDOUT_CAP_BYTES = 1_048_576;

/** Call a script's public endpoint with a tiny wall clock and return the envelope. */
async function callEndpoint(
  ctx: ScenarioContext,
  endpointId: string,
  token: string,
  timeoutMs: string,
): Promise<{ status: number; body: Record<string, unknown>; elapsedMs: number }> {
  const started = performance.now();
  const response = await fetch(`${ctx.baseUrl}/api/x/script/${endpointId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Swarm-Timeout-Ms": timeoutMs,
    },
    body: "{}",
  });
  const elapsedMs = performance.now() - started;
  ctx.recordHttpCall("POST", `/api/x/script/${endpointId}`, response.status, elapsedMs);
  return { status: response.status, body: asRecord(await response.json()), elapsedMs };
}

async function exposeScript(
  ctx: ScenarioContext,
  agentId: string,
  name: string,
  source: string,
  executor: "native" | "quickjs" | null,
): Promise<{ endpointId: string; token: string; scriptId: string }> {
  const saved = await upsertScript(ctx, agentId, { name, source, executor });
  const endpoint = await ctx.api("POST", `/api/scripts/${saved.id}/apis`, {
    body: { label: name, agentId },
  });
  expectStatus(endpoint, [201], `expose ${name}`);
  const created = asRecord(endpoint.json);
  return {
    endpointId: String(created.id),
    token: String(created.token),
    scriptId: saved.id,
  };
}

/**
 * Flow `script-limits`: the sandbox limits and failure surfaces. Wall-clock timeout (through
 * the public endpoint, whose X-Swarm-Timeout-Ms floor is one second), the 1 MiB output cap,
 * thrown errors, both executors, per-script executor choice and workspace-rw (501).
 */
export const scriptLimits: Scenario = {
  name: "script-limits",
  order: 430,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "limits");

    // ── output caps: the run still succeeds, the capture is cut at 1 MiB ──
    const capped = await runScript(ctx, agentId, {
      source: `export default async function () {
  console.log("x".repeat(1_200_000));
  console.error("e".repeat(1_200_000));
  return "survived";
}`,
      intent: `e2e output cap ${ctx.nonce}`,
    });
    expectRunOk(capped, "output cap run");
    expect(capped.result === "survived", "a capped run must still return its result");
    expect(
      JSON.stringify(capped.truncated) === JSON.stringify({ stdout: true, stderr: true }),
      `both streams must be flagged truncated: ${JSON.stringify(capped.truncated)}`,
    );
    expect(
      String(capped.stdout).length === STDOUT_CAP_BYTES &&
        String(capped.stderr).length === STDOUT_CAP_BYTES,
      "captured output must be cut at 1 MiB",
    );
    const cappedQuick = await runScript(ctx, agentId, {
      source: `export default async function () { console.log("x".repeat(1_200_000)); return "q"; }`,
      executor: "quickjs",
      intent: `e2e output cap quickjs ${ctx.nonce}`,
    });
    expectRunOk(cappedQuick, "quickjs output cap run");
    expect(
      asRecord(cappedQuick.truncated).stdout === true &&
        String(cappedQuick.stdout).length === STDOUT_CAP_BYTES,
      "quickjs must cap stdout at 1 MiB too",
    );

    // ── both executors run a trivial script and report the same envelope shape ──
    for (const executor of ["native", "quickjs"] as const) {
      const run = await runScript(ctx, agentId, {
        source: `export default async function (args: { n: number }) { return { sum: args.n + 1 }; }`,
        args: { n: 41 },
        executor,
        intent: `e2e trivial ${executor} ${ctx.nonce}`,
      });
      expectRunOk(run, `${executor} trivial run`);
      expect(asRecord(run.result).sum === 42, `${executor} returned the wrong result`);
      expect(
        Object.keys(run).sort().join(",") ===
          "autoSaved,durationMs,exitCode,result,stderr,stdout,truncated",
        `${executor} envelope shape drifted: ${Object.keys(run).sort().join(",")}`,
      );
    }
    // thrown errors and process exits surface the same way on quickjs
    const quickThrow = await runScript(ctx, agentId, {
      source: `export default async function () { throw new Error("quick-${ctx.nonce}"); }`,
      executor: "quickjs",
    });
    expect(
      quickThrow.exitCode === 1 &&
        quickThrow.error === "eval_error" &&
        asRecord(quickThrow.runtimeError).message === `quick-${ctx.nonce}`,
      `quickjs thrown error is wrong: ${JSON.stringify(quickThrow).slice(0, 300)}`,
    );
    const unknownExecutor = await ctx.api("POST", "/api/scripts/run", {
      agentId,
      body: { source: "export default async () => 1", executor: "bogus" },
    });
    expectStatus(unknownExecutor, [400], "unknown executor");
    const unknownSaved = await ctx.api("POST", "/api/scripts/upsert", {
      agentId,
      body: {
        name: `e2e-bad-exec-${ctx.nonce}`,
        source: "export default async () => 1",
        executor: "bogus",
      },
    });
    expectStatus(unknownSaved, [400], "unknown executor on upsert");

    // ── a script saved with executor=quickjs runs there until the caller overrides it ──
    const probeName = `e2e-exec-probe-${ctx.nonce}`;
    const probeSource = `export default async function (args: unknown, ctx: any) {
  try {
    await ctx.stdlib.glob("*");
    return { globOk: true };
  } catch (error: any) {
    return { globOk: false, message: String(error?.message ?? error) };
  }
}`;
    const saved = await ctx.api("POST", "/api/scripts/upsert", {
      agentId,
      body: { name: probeName, source: probeSource, executor: "quickjs" },
    });
    expectStatus(saved, [200], "save a quickjs-pinned script");
    const warnings = asRecord(saved.json).warnings;
    expect(
      Array.isArray(warnings) && warnings.some((entry) => String(entry).includes("stdlib.glob")),
      `saving a quickjs script that needs the filesystem must warn: ${saved.text}`,
    );
    const listed = await ctx.api("GET", "/api/scripts?scope=agent");
    const listedProbe = asRecord(listed.json).scripts;
    expect(
      Array.isArray(listedProbe) &&
        listedProbe.map(asRecord).some((s) => s.name === probeName && s.executor === "quickjs"),
      "the saved executor must be listed",
    );
    const inherited = asRecord((await runScript(ctx, agentId, { name: probeName })).result);
    expect(
      inherited.globOk === false && String(inherited.message).includes("quickjs executor"),
      `a quickjs-pinned script must run on quickjs: ${JSON.stringify(inherited)}`,
    );
    const nativeOverride = asRecord(
      (await runScript(ctx, agentId, { name: probeName, executor: "native" })).result,
    );
    expect(nativeOverride.globOk === true, "executor:'native' must override the saved executor");
    const nullOverride = asRecord(
      (await runScript(ctx, agentId, { name: probeName, executor: null })).result,
    );
    expect(nullOverride.globOk === true, "executor:null must fall back to the deployment default");

    // ── workspace-rw is refused on every run path ──
    const rwInline = await ctx.api("POST", "/api/scripts/run", {
      agentId,
      body: { source: "export default async () => 1", fsMode: "workspace-rw" },
    });
    expectStatus(rwInline, [501], "workspace-rw inline run");
    expect(
      String(asRecord(rwInline.json).error).includes("workspace-rw"),
      "the 501 must name workspace-rw",
    );

    // ── wall-clock timeout through the public endpoint (floor: one second) ──
    const nativeSleep = await exposeScript(
      ctx,
      agentId,
      `e2e-sleep-native-${ctx.nonce}`,
      `export default async function () { await new Promise((resolve) => setTimeout(resolve, 8000)); return "late"; }`,
      null,
    );
    const timedOut = await callEndpoint(ctx, nativeSleep.endpointId, nativeSleep.token, "1000");
    expect(timedOut.status === 200, "a timeout is reported in the envelope, not as an HTTP error");
    const timeoutError = asRecord(timedOut.body.error);
    expect(
      timedOut.body.ok === false &&
        timeoutError.type === "timeout" &&
        timedOut.body.result === null,
      `native sleep must time out: ${JSON.stringify(timedOut.body)}`,
    );
    expect(
      Number(timedOut.body.durationMs) >= 900 && timedOut.elapsedMs < 6_000,
      `the wall clock did not cut the run near 1s: ${timedOut.elapsedMs}ms`,
    );
    // the floor: a smaller header value is raised to one second, never to zero
    const clamped = await callEndpoint(ctx, nativeSleep.endpointId, nativeSleep.token, "5");
    expect(
      asRecord(clamped.body.error).type === "timeout" && Number(clamped.body.durationMs) >= 900,
      `X-Swarm-Timeout-Ms below the floor must be raised to 1s: ${JSON.stringify(clamped.body)}`,
    );

    const spin = await exposeScript(
      ctx,
      agentId,
      `e2e-spin-native-${ctx.nonce}`,
      "export default async function () { while (true) {} }",
      "native",
    );
    const spun = await callEndpoint(ctx, spin.endpointId, spin.token, "1000");
    expect(
      asRecord(spun.body.error).type === "timeout" && spun.elapsedMs < 8_000,
      `a CPU-bound native script must be killed at the wall clock: ${JSON.stringify(spun.body)}`,
    );

    const quickSleep = await exposeScript(
      ctx,
      agentId,
      `e2e-sleep-quick-${ctx.nonce}`,
      `export default async function () { await new Promise((resolve) => setTimeout(resolve, 8000)); return "late"; }`,
      "quickjs",
    );
    const quickTimedOut = await callEndpoint(ctx, quickSleep.endpointId, quickSleep.token, "1000");
    expect(
      asRecord(quickTimedOut.body.error).type === "timeout" && quickTimedOut.elapsedMs < 6_000,
      `quickjs sleep must time out: ${JSON.stringify(quickTimedOut.body)}`,
    );

    // a script that finishes inside the window is not affected by a small header
    const quick = await exposeScript(
      ctx,
      agentId,
      `e2e-fast-${ctx.nonce}`,
      "export default async function () { return { fast: true }; }",
      null,
    );
    const fast = await callEndpoint(ctx, quick.endpointId, quick.token, "2000");
    expect(
      fast.body.ok === true && asRecord(fast.body.result).fast === true && fast.body.error === null,
      `a fast script must succeed: ${JSON.stringify(fast.body)}`,
    );

    // timeouts leave the failed run recorded as an inline run row
    const failedRows = ctx.db.query<{ status: string }>(
      "SELECT status FROM script_runs WHERE agentId = ? AND status = 'failed'",
      [agentId],
    );
    expect(failedRows.length >= 1, "timed-out endpoint runs must be recorded as failed runs");

    for (const exposed of [nativeSleep, spin, quickSleep, quick]) {
      const removed = await ctx.api(
        "DELETE",
        `/api/scripts/${exposed.scriptId}/apis/${exposed.endpointId}`,
      );
      expectStatus(removed, [200], "remove the limits endpoint");
    }
  },
};
