// One step of a stress workflow. The node's args pick the action. Counters
// live in KV under stress/wf/<run id>/ and the scoreboard deletes them later,
// so a step that runs twice is still visible to the check at the end.
type StepArgs = {
  action?: string;
  runId?: string;
  branch?: string;
  expect?: number | string;
  failTimes?: number | string;
  id?: string;
  item?: string;
  parentRunId?: string;
  storm?: string;
  key?: string;
  minMs?: number | string;
  maxMs?: number | string;
  count?: number | string;
  flaky?: unknown;
  doomed?: unknown;
  fan?: unknown;
  port?: string;
};

/** Workflow interpolation turns an object into JSON text. Undo that. */
function asObject(value: unknown): Any {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return { unparsed: value.slice(0, 200) };
  }
}

export default async function (args: StepArgs | undefined, ctx: ScriptContext) {
  const startedAt = Date.now();
  const g = await gate(ctx);
  const a = args ?? {};
  const action = a.action ?? "";
  if (!g.enabled) {
    // The pack is paused. Answer with a shape the next node can still read.
    return { skipped: true, attempt: 0, items: [] };
  }
  const env: StressEnv = { level: g.level, id: a.runId ?? a.parentRunId ?? newId(), startedAt };
  const wf = (suffix: string) => `stress/wf/${a.runId ?? a.parentRunId}/${suffix}`;
  const incr = async (suffix: string): Promise<number> => {
    const res = (await ctx.swarm.kv_incr({ namespace: NS, key: wf(suffix) })) as Sdk;
    if (!res.success) throw new Error(`kv_incr ${suffix} failed: HTTP ${res.status}`);
    return Number(res.data.value);
  };
  const read = async (suffix: string): Promise<number> =>
    Number((await kvValue(ctx, wf(suffix))) ?? 0);
  const finish = async (name: string, t: Tally, nums: Record<string, unknown>) =>
    record(ctx, name, env, t, nums);

  switch (action) {
    // ---- shared ----
    case "mark": {
      await ctx.swarm.kv_set({
        namespace: NS,
        key: wf("t0"),
        value: startedAt,
        valueType: "integer",
      });
      return { t0: startedAt };
    }

    // ---- A. fan-out and join ----
    case "incr": {
      const total = await incr("n");
      const mine = await incr(`b/${a.branch}`);
      await sleep(250); // keep the branches in flight at the same time
      return { branch: a.branch, total, mine };
    }
    case "join": {
      const t = tally();
      const expect = Number(a.expect);
      const joined = await incr("joined");
      const n = await read("n");
      const listed = (await ctx.swarm.kv_list({
        namespace: NS,
        prefix: wf("b/"),
        limit: 100,
      })) as Sdk;
      const branches: Any[] = listed.data?.entries ?? [];
      const t0 = await read("t0");
      t.ok("join-ran-once", joined === 1, { joined });
      t.ok("counter-equals-branch-count", n === expect, { n, expect });
      t.ok(
        "every-branch-ran-exactly-once",
        branches.length === expect && branches.every((entry) => entry.value === 1),
        branches.map((entry) => `${String(entry.key).split("/").pop()}=${entry.value}`),
      );
      return finish("wf-fanout", t, {
        branches: branches.length,
        n,
        joined,
        fanMs: startedAt - t0,
      });
    }

    // ---- B. retry and error path ----
    case "flaky": {
      const attempt = await incr("flaky");
      const failTimes = Number(a.failTimes ?? 2);
      if (attempt <= failTimes) {
        throw new Error(
          `${EXPECTED}_FLAKY: attempt ${attempt} of ${failTimes + 1} fails on purpose`,
        );
      }
      return { attempt, items: [{ id: "always-fails" }, { id: "passes" }, { id: "passes-too" }] };
    }
    case "fail-if": {
      await incr(`item/${a.id}`);
      if (a.id === "always-fails")
        throw new Error(`${EXPECTED}_DOOMED: this item fails on purpose`);
      return { id: a.id };
    }
    case "retry-check": {
      const t = tally();
      const flaky = asObject(a.flaky);
      const doomed = asObject(a.doomed);
      const attempts = await read("flaky");
      const results: Any[] = doomed.results ?? [];
      const failedItem = results.find((item) => item.itemKey === "always-fails");
      t.ok("flaky-node-passed-on-third-attempt", flaky.result?.attempt === 3 && attempts === 3, {
        resultAttempt: flaky.result?.attempt,
        attempts,
      });
      t.ok("fan-out-collected-one-failure", doomed.okCount === 2 && doomed.failedCount === 1, {
        okCount: doomed.okCount,
        failedCount: doomed.failedCount,
      });
      t.ok(
        "failed-item-keeps-its-error",
        failedItem?.status === "failed" && JSON.stringify(failedItem).includes(EXPECTED),
        JSON.stringify(failedItem ?? null).slice(0, 240),
      );
      t.ok(
        "each-item-ran-once",
        (await read("item/always-fails")) === 1 &&
          (await read("item/passes")) === 1 &&
          (await read("item/passes-too")) === 1,
        { fails: await read("item/always-fails"), passes: await read("item/passes") },
      );
      t.ok("check-node-ran-once", (await incr("checked")) === 1, {});
      return finish("wf-retry", t, {
        attempts,
        okCount: doomed.okCount,
        failedCount: doomed.failedCount,
      });
    }

    // ---- C. wait and resume ----
    case "port": {
      // Counts which port a wait node left through.
      return { port: a.port, hits: await incr(`port/${a.port}`) };
    }
    case "wait-check": {
      const t = tally();
      const resumed = await incr("resumed");
      const t0 = await read("t0");
      const waitedMs = startedAt - t0;
      const minMs = Number(a.minMs);
      const maxMs = Number(a.maxMs);
      t.ok("run-resumed-once", resumed === 1, { resumed });
      t.ok("wait-lasted-the-configured-time", waitedMs >= minMs && waitedMs <= maxMs, {
        waitedMs,
        minMs,
        maxMs,
      });
      t.ok("event-wait-left-through-timeout-port", (await read("port/timeout")) === 1, {
        timeout: await read("port/timeout"),
        event: await read("port/event"),
      });
      return finish("wf-wait", t, { waitedMs, resumed });
    }

    // ---- D. nested runs ----
    case "plan": {
      const count = Number(a.count ?? 4) * g.level;
      return { items: Array.from({ length: count }, (_, i) => ({ id: `c${i + 1}` })) };
    }
    case "child-work": {
      const children = await incr("children");
      const mine = await incr(`child/${a.item}`);
      await sleep(250);
      return { item: a.item, children, mine };
    }
    case "parent-check": {
      const t = tally();
      const fan = asObject(a.fan);
      const expect = Number(a.expect) * g.level;
      const results: Any[] = fan.results ?? [];
      const children = await read("children");
      const listed = (await ctx.swarm.kv_list({
        namespace: NS,
        prefix: wf("child/"),
        limit: 100,
      })) as Sdk;
      const perChild: Any[] = listed.data?.entries ?? [];
      const childRunIds = results.map((item) => item.output?.runId).filter(Boolean);
      t.ok("every-child-run-completed", fan.okCount === expect && fan.failedCount === 0, {
        okCount: fan.okCount,
        failedCount: fan.failedCount,
        expect,
      });
      t.ok(
        "each-child-returned-its-own-item",
        results.length === expect &&
          results.every((item) => item.output?.outputs?.work?.result?.item === item.itemKey),
        JSON.stringify(results[0] ?? null).slice(0, 240),
      );
      t.ok("child-run-ids-are-distinct", new Set(childRunIds).size === expect, {
        distinct: new Set(childRunIds).size,
        expect,
      });
      t.ok(
        "child-counter-equals-child-count",
        children === expect &&
          perChild.length === expect &&
          perChild.every((entry) => entry.value === 1),
        { children, expect, perChild: perChild.length },
      );
      t.ok("join-ran-once", (await incr("joined")) === 1, {});
      return finish("wf-nested", t, { children, expect });
    }

    // ---- E. duplicate triggers ----
    case "dedup-hit": {
      const res = (await ctx.swarm.kv_incr({
        namespace: NS,
        key: `stress/storm/${a.storm}/hits/${a.key}`,
      })) as Sdk;
      return { storm: a.storm, key: a.key, hits: res.data?.value };
    }

    default:
      throw new Error(`stress-wf-step: unknown action "${action}"`);
  }
}
