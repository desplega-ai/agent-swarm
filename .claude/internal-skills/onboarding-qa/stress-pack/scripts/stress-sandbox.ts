// Sandbox behaviour: five nested runs at the same time, and the status and
// fields each one ends with. Run as a workflow node (it needs about 35 s,
// because the timeout case waits for the 30 s nested-run limit).
export default async function (_args: unknown, ctx: ScriptContext) {
  return stressRun(ctx, "sandbox", async (t) => {
    const run = async (args: Record<string, unknown>) => {
      const started = Date.now();
      try {
        const res = (await ctx.swarm.script_run({
          name: "stress-sandbox-case",
          scope: "global",
          args,
        })) as Sdk;
        return { http: res.status, wallMs: Date.now() - started, env: (res.data ?? {}) as Any };
      } catch (err) {
        return { http: 0, wallMs: Date.now() - started, env: { thrown: errText(err) } as Any };
      }
    };
    const [cpu, nap, boom, late, flood] = await Promise.all([
      run({ mode: "cpu", ms: 2000 }),
      run({ mode: "sleep", ms: 3000 }),
      run({ mode: "throw" }),
      run({ mode: "timeout" }),
      run({ mode: "flood", kb: 1536 }),
    ]);
    const brief = (r: { http: number; wallMs: number; env: Any }) => ({
      http: r.http,
      wallMs: r.wallMs,
      exitCode: r.env.exitCode,
      error: r.env.error,
      durationMs: r.env.durationMs,
      truncated: r.env.truncated,
      runtimeError: r.env.runtimeError?.message?.slice(0, 120),
      stdoutBytes: typeof r.env.stdout === "string" ? r.env.stdout.length : undefined,
      stderr: typeof r.env.stderr === "string" ? r.env.stderr.slice(0, 160) : undefined,
      result: JSON.stringify(r.env.result ?? null).slice(0, 120),
      thrown: r.env.thrown,
    });

    t.ok(
      "cpu-run-completes",
      cpu.http === 200 && cpu.env.exitCode === 0 && !cpu.env.error && cpu.env.result?.spins > 0,
      brief(cpu),
    );
    t.ok(
      "cpu-run-took-about-2s",
      cpu.env.durationMs >= 1900 && cpu.env.durationMs < 15_000,
      brief(cpu),
    );

    t.ok(
      "sleep-run-completes",
      nap.http === 200 &&
        nap.env.exitCode === 0 &&
        !nap.env.error &&
        nap.env.result?.mode === "sleep",
      brief(nap),
    );
    t.ok(
      "sleep-run-took-about-3s",
      nap.env.durationMs >= 2900 && nap.env.durationMs < 15_000,
      brief(nap),
    );

    t.ok(
      "throw-run-fails-with-its-message",
      boom.http === 200 &&
        boom.env.exitCode !== 0 &&
        String(boom.env.runtimeError?.message ?? boom.env.stderr).includes(EXPECTED),
      brief(boom),
    );
    t.ok(
      "throw-run-has-no-result-and-no-timeout",
      boom.env.result === undefined && boom.env.error !== "timeout",
      brief(boom),
    );

    t.ok(
      "timeout-run-ends-as-timeout",
      late.http === 200 && late.env.error === "timeout" && late.env.exitCode !== 0,
      brief(late),
    );
    t.ok(
      "timeout-run-is-stopped-near-30s",
      late.env.durationMs >= 28_000 &&
        late.env.durationMs <= 45_000 &&
        late.env.result === undefined,
      brief(late),
    );

    t.ok(
      "flood-run-is-truncated",
      flood.http === 200 && flood.env.truncated?.stdout === true,
      brief(flood),
    );
    t.ok(
      "flood-run-stdout-stays-under-the-cap",
      typeof flood.env.stdout === "string" && flood.env.stdout.length <= 1_048_576 + 4096,
      brief(flood),
    );
    t.ok(
      "flood-run-still-returns-its-result",
      flood.env.exitCode === 0 && flood.env.result?.mode === "flood",
      brief(flood),
    );

    return {
      cpuMs: cpu.env.durationMs,
      sleepMs: nap.env.durationMs,
      timeoutMs: late.env.durationMs,
      floodStdoutBytes: typeof flood.env.stdout === "string" ? flood.env.stdout.length : -1,
      floodExitCode: flood.env.exitCode,
      throwError: boom.env.error ?? null,
    };
  });
}
