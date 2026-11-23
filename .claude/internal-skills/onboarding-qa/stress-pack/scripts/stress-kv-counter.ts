// KV counter contention: no increment may be lost, inside one run and across
// concurrent runs. A read-modify-write on the side shows what the atomic
// increment protects against.
type CounterArgs = { mode?: "child"; key?: string; n?: number };

async function incrMany(
  ctx: ScriptContext,
  key: string,
  n: number,
): Promise<{ values: number[]; bad: string[] }> {
  const res = (await Promise.all(
    Array.from({ length: n }, () => ctx.swarm.kv_incr({ namespace: NS, key })),
  )) as Sdk[];
  const values: number[] = [];
  const bad: string[] = [];
  for (const r of res) {
    if (r.success && typeof r.data?.value === "number") values.push(r.data.value);
    else bad.push(`HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  }
  return { values, bad };
}

/** True when `values` holds every integer from 1 to n exactly once. */
function isOneToN(values: number[], n: number): boolean {
  if (values.length !== n) return false;
  const seen = new Set(values);
  if (seen.size !== n) return false;
  for (let i = 1; i <= n; i++) if (!seen.has(i)) return false;
  return true;
}

export default async function (args: CounterArgs | undefined, ctx: ScriptContext) {
  if (args?.mode === "child") {
    // A nested run started by the parent below. It shares the parent's key.
    const g = await gate(ctx);
    if (!g.enabled || !args.key || !args.n) return { skipped: true, values: [], bad: [] };
    return incrMany(ctx, args.key, args.n);
  }

  return stressRun(ctx, "kv-counter", async (t, env) => {
    const base = `stress/ctr/${env.id}`;
    const n = 20 * env.level;

    // 1. Atomic increments, in parallel, inside one run.
    const atomic = await incrMany(ctx, `${base}/atomic`, n);
    t.ok("atomic-no-errors", atomic.bad.length === 0, atomic.bad.slice(0, 3));
    t.ok("atomic-returns-1-to-n-once-each", isOneToN(atomic.values, n), {
      n,
      got: atomic.values.length,
      distinct: new Set(atomic.values).size,
    });
    const atomicFinal = await kvValue(ctx, `${base}/atomic`);
    t.ok("atomic-final-equals-n", atomicFinal === n, { atomicFinal, n });

    // Steps other than +1, one after the other: the sum must come back to n.
    for (const by of [5, -3, 1_000_000, -1_000_002]) {
      await ctx.swarm.kv_incr({ namespace: NS, key: `${base}/atomic`, by });
    }
    const stepped = await kvValue(ctx, `${base}/atomic`);
    t.ok("signed-steps-sum-to-n", stepped === n, { stepped, n });

    // 2. Read-modify-write, in parallel. It loses updates by design. The numbers
    //    show how many, and the check only needs a final value in range.
    const rmwKey = `${base}/rmw`;
    await ctx.swarm.kv_set({ namespace: NS, key: rmwKey, value: 0, valueType: "integer" });
    await Promise.all(
      Array.from({ length: n }, async () => {
        const current = Number(await kvValue(ctx, rmwKey));
        await ctx.swarm.kv_set({
          namespace: NS,
          key: rmwKey,
          value: current + 1,
          valueType: "integer",
        });
      }),
    );
    const rmwFinal = Number(await kvValue(ctx, rmwKey));
    t.ok("rmw-final-in-range", rmwFinal >= 1 && rmwFinal <= n, { rmwFinal, n });

    // 3. One key, written by concurrent runs: nested runs of this script plus
    //    this run itself, all at the same time.
    const childRuns = 1 + env.level;
    const per = 10 * env.level;
    const sharedKey = `${base}/shared`;
    const own = incrMany(ctx, sharedKey, per);
    const children = await Promise.all(
      Array.from({ length: childRuns }, async () => {
        try {
          return (await ctx.swarm.script_run({
            name: "stress-kv-counter",
            scope: "global",
            args: { mode: "child", key: sharedKey, n: per },
          })) as Sdk;
        } catch (err) {
          return { success: false, status: 0, data: { thrown: errText(err) } } as Sdk;
        }
      }),
    );
    const mine = await own;
    const total = per * (childRuns + 1);
    const all = [...mine.values];
    const childProblems: string[] = [...mine.bad];
    for (const child of children) {
      const envelope = child.data ?? {};
      if (!child.success || envelope.exitCode !== 0 || envelope.error) {
        childProblems.push(JSON.stringify(envelope).slice(0, 200));
        continue;
      }
      all.push(...((envelope.result?.values ?? []) as number[]));
      childProblems.push(...((envelope.result?.bad ?? []) as string[]));
    }
    t.ok("cross-run-no-errors", childProblems.length === 0, childProblems.slice(0, 3));
    t.ok("cross-run-returns-1-to-total-once-each", isOneToN(all, total), {
      total,
      got: all.length,
      distinct: new Set(all).size,
    });
    const sharedFinal = await kvValue(ctx, sharedKey);
    t.ok("cross-run-final-equals-total", sharedFinal === total, { sharedFinal, total });

    // 4. Clean up. Every delete must find its key.
    const gone = (await Promise.all(
      [`${base}/atomic`, rmwKey, sharedKey].map((key) =>
        ctx.swarm.kv_delete({ namespace: NS, key }),
      ),
    )) as Sdk[];
    t.ok(
      "cleanup-deletes-return-204",
      gone.every((r) => r.status === 204),
      gone.map((r) => r.status),
    );

    return { n, rmwFinal, rmwLost: n - rmwFinal, crossRuns: childRuns + 1, crossTotal: total };
  });
}
