import { describe, expect, test } from "bun:test";
import {
  baselineMs,
  type Clock,
  createDokployApi,
  DEFAULT_OPTIONS,
  DeployError,
  type Deployment,
  type DeployOptions,
  type DokployApi,
  DokployApiError,
  deploy,
  optionsFromEnv,
  recordsAfter,
} from "../../scripts/dokploy-deploy";

const T0 = Date.parse("2026-09-30T00:00:00.000Z");
const iso = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000).toISOString();

function rec(id: string, createdOffset: number, status = "done"): Deployment {
  return { deploymentId: id, status, createdAt: iso(createdOffset), finishedAt: null };
}

/** Virtual time: sleep() only advances the counter, so a 7-minute wait runs instantly. */
function fakeClock(): Clock & { elapsedSeconds(): number } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    elapsedSeconds: () => t / 1000,
  };
}

const OPTIONS: DeployOptions = { ...DEFAULT_OPTIONS };

type Sim = {
  api: DokployApi;
  clock: ReturnType<typeof fakeClock>;
  triggers: () => number;
};

/**
 * `visible(triggerCount, secondsSinceLastTrigger)` returns the records the list endpoint
 * shows. The baseline record (`old`, created 1h before T0) is always present.
 */
function simulate(
  visible: (triggerCount: number, sinceTrigger: number) => Deployment[],
  hooks: { trigger?: (n: number) => void; list?: (n: number) => void } = {},
): Sim {
  const clock = fakeClock();
  let triggerCount = 0;
  let lastTrigger = 0;
  const old = rec("old", -3600);
  const api: DokployApi = {
    async listDeployments() {
      hooks.list?.(triggerCount);
      return [old, ...visible(triggerCount, (clock.now() - lastTrigger) / 1000)];
    },
    async triggerDeploy() {
      triggerCount += 1;
      lastTrigger = clock.now();
      hooks.trigger?.(triggerCount);
    },
  };
  return { api, clock, triggers: () => triggerCount };
}

const quiet = () => {};

describe("recordsAfter / baselineMs", () => {
  test("baseline is the newest createdAt even when the list is not newest-first", () => {
    const list = [rec("a", -100), rec("b", -10), rec("c", -50)];
    expect(baselineMs(list)).toBe(T0 - 10_000);
    expect(recordsAfter(list, baselineMs(list))).toEqual([]);
  });

  test("returns only newer records, newest first; an empty history has baseline 0", () => {
    expect(baselineMs([])).toBe(0);
    const list = [rec("a", 5), rec("b", 20), rec("c", -5)];
    expect(recordsAfter(list, T0).map((d) => d.deploymentId)).toEqual(["b", "a"]);
  });
});

describe("deploy", () => {
  test("healthy run: record appears within seconds, single trigger", async () => {
    const sim = simulate((n, s) => (n >= 1 && s >= 10 ? [rec("new", 10)] : []));
    const out = await deploy(sim.api, OPTIONS, sim.clock, quiet);
    expect(out.deploymentId).toBe("new");
    expect(sim.triggers()).toBe(1);
  });

  test("a record that appears 364s after the trigger is accepted (old 240s window failed here)", async () => {
    const sim = simulate((n, s) => (n >= 1 && s >= 364 ? [rec("late", 364)] : []));
    const out = await deploy(sim.api, OPTIONS, sim.clock, quiet);
    expect(out.deploymentId).toBe("late");
    expect(sim.triggers()).toBe(1);
    expect(sim.clock.elapsedSeconds()).toBeGreaterThanOrEqual(364);
  });

  test("control: the old policy (one trigger, 240s window) fails on that same 364s trace", async () => {
    const sim = simulate((n, s) => (n >= 1 && s >= 364 ? [rec("late", 364)] : []));
    const err = await deploy(
      sim.api,
      { ...OPTIONS, maxTriggers: 1, recordWaitMs: 240_000 },
      sim.clock,
      quiet,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect(err.message).toContain("No deployment record appeared");
  });

  test("no record after the wait: triggers again and succeeds when the second one registers", async () => {
    const sim = simulate((n, s) => (n >= 2 && s >= 10 ? [rec("second", 10)] : []));
    const logs: string[] = [];
    const out = await deploy(sim.api, OPTIONS, sim.clock, (m) => logs.push(m));
    expect(out.deploymentId).toBe("second");
    expect(sim.triggers()).toBe(2);
    expect(logs.some((m) => m.includes("triggering again"))).toBe(true);
  });

  test("no record ever: fails after maxTriggers with a message that says what was tried", async () => {
    const sim = simulate(() => []);
    const err = await deploy(sim.api, OPTIONS, sim.clock, quiet).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect(err.message).toContain("after 3 trigger(s)");
    expect(err.message).toContain("420s");
    expect(sim.triggers()).toBe(3);
  });

  test("a record created before the baseline never counts as new", async () => {
    // Only the pre-existing record is listed: nothing new, so the run must fail, not pass on it.
    const sim = simulate(() => []);
    await expect(
      deploy(sim.api, { ...OPTIONS, maxTriggers: 1, recordWaitMs: 30_000 }, sim.clock, quiet),
    ).rejects.toBeInstanceOf(DeployError);
  });

  test("follows a running deployment to done", async () => {
    const sim = simulate((n, s) => {
      if (n < 1 || s < 5) return [];
      return [rec("new", 5, s < 200 ? "running" : "done")];
    });
    const out = await deploy(sim.api, OPTIONS, sim.clock, quiet);
    expect(out.status).toBe("done");
    expect(sim.clock.elapsedSeconds()).toBeGreaterThanOrEqual(200);
  });

  test("newest deployment errored: fails with its message", async () => {
    const sim = simulate((n) =>
      n >= 1 ? [{ ...rec("bad", 5, "error"), errorMessage: "pull access denied" }] : [],
    );
    const err = await deploy(sim.api, OPTIONS, sim.clock, quiet).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect(err.message).toContain("bad");
    expect(err.message).toContain("pull access denied");
  });

  test("an earlier deployment errored but a later one is done: succeeds", async () => {
    const sim = simulate((n) =>
      n >= 1 ? [rec("first", 5, "error"), rec("second", 60, "done")] : [],
    );
    const out = await deploy(sim.api, OPTIONS, sim.clock, quiet);
    expect(out.deploymentId).toBe("second");
  });

  test("waits for a still-running earlier record before judging the newest", async () => {
    const sim = simulate((n, s) =>
      n >= 1 ? [rec("first", 5, s < 100 ? "running" : "done"), rec("second", 60, "done")] : [],
    );
    await deploy(sim.api, OPTIONS, sim.clock, quiet);
    expect(sim.clock.elapsedSeconds()).toBeGreaterThanOrEqual(100);
  });

  test("a deployment stuck in running fails at the completion timeout", async () => {
    const sim = simulate((n) => (n >= 1 ? [rec("stuck", 5, "running")] : []));
    const err = await deploy(
      sim.api,
      { ...OPTIONS, completionTimeoutMs: 60_000 },
      sim.clock,
      quiet,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DeployError);
    expect(err.message).toContain("stuck=running");
  });

  test("a transient list failure while waiting is tolerated", async () => {
    let failures = 0;
    const sim = simulate((n, s) => (n >= 1 && s >= 20 ? [rec("new", 20)] : []), {
      list: (n) => {
        if (n >= 1 && failures < 3) {
          failures += 1;
          throw new DokployApiError("HTTP 502", true);
        }
      },
    });
    const out = await deploy(sim.api, OPTIONS, sim.clock, quiet);
    expect(out.deploymentId).toBe("new");
    expect(failures).toBe(3);
  });

  test("a 4xx on trigger is deterministic: no retry", async () => {
    const sim = simulate(() => [], {
      trigger: () => {
        throw new DokployApiError("HTTP 401", false);
      },
    });
    await expect(deploy(sim.api, OPTIONS, sim.clock, quiet)).rejects.toThrow("HTTP 401");
    expect(sim.triggers()).toBe(1);
  });

  test("a 5xx on the first trigger retries after a backoff", async () => {
    const sim = simulate((n, s) => (n >= 2 && s >= 5 ? [rec("new", 5)] : []), {
      trigger: (n) => {
        if (n === 1) throw new DokployApiError("HTTP 503", true);
      },
    });
    const out = await deploy(sim.api, OPTIONS, sim.clock, quiet);
    expect(out.deploymentId).toBe("new");
    expect(sim.triggers()).toBe(2);
    expect(sim.clock.elapsedSeconds()).toBeGreaterThanOrEqual(30);
  });
});

describe("createDokployApi", () => {
  test("sends the api key and a user-agent, and posts the compose id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(init?.method === "POST" ? "true" : "[]", { status: 200 });
    }) as typeof fetch;
    const api = createDokployApi("https://dokploy.example/", "tok", "cmp 1", fake);
    await api.listDeployments();
    await api.triggerDeploy();
    expect(calls[0]?.url).toBe(
      "https://dokploy.example/api/deployment.allByCompose?composeId=cmp%201",
    );
    expect(calls[1]?.url).toBe("https://dokploy.example/api/compose.deploy");
    expect(calls[1]?.init.body).toBe(JSON.stringify({ composeId: "cmp 1" }));
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("tok");
    expect(headers["user-agent"]).toBeTruthy();
  });

  test("classifies 4xx as non-retryable and 5xx/429 as retryable", async () => {
    const respond = (status: number) =>
      createDokployApi(
        "https://d.example",
        "t",
        "c",
        (async () => new Response("nope", { status })) as unknown as typeof fetch,
      );
    const forbidden = await respond(403)
      .listDeployments()
      .catch((e) => e);
    expect(forbidden).toBeInstanceOf(DokployApiError);
    expect(forbidden.retryable).toBe(false);
    for (const status of [429, 502]) {
      const err = await respond(status)
        .listDeployments()
        .catch((e) => e);
      expect(err.retryable).toBe(true);
    }
  });

  test("a non-array list body is a retryable error, not a crash", async () => {
    const api = createDokployApi(
      "https://d.example",
      "t",
      "c",
      (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    );
    const err = await api.listDeployments().catch((e) => e);
    expect(err).toBeInstanceOf(DokployApiError);
    expect(err.retryable).toBe(true);
  });
});

describe("optionsFromEnv", () => {
  const KEYS = [
    "DOKPLOY_RECORD_WAIT_SECONDS",
    "DOKPLOY_MAX_TRIGGERS",
    "DOKPLOY_COMPLETION_TIMEOUT_SECONDS",
    "DOKPLOY_POLL_SECONDS",
    "DOKPLOY_RETRY_BACKOFF_SECONDS",
  ];
  const withEnv = (env: Record<string, string>, fn: () => void) => {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  test("defaults", () => withEnv({}, () => expect(optionsFromEnv()).toEqual(DEFAULT_OPTIONS)));

  test("overrides are read in seconds", () =>
    withEnv({ DOKPLOY_RECORD_WAIT_SECONDS: "60", DOKPLOY_MAX_TRIGGERS: "2" }, () => {
      const o = optionsFromEnv();
      expect(o.recordWaitMs).toBe(60_000);
      expect(o.maxTriggers).toBe(2);
    }));

  test("garbage values throw instead of silently using the default", () => {
    withEnv({ DOKPLOY_RECORD_WAIT_SECONDS: "abc" }, () => expect(() => optionsFromEnv()).toThrow());
    withEnv({ DOKPLOY_MAX_TRIGGERS: "0" }, () => expect(() => optionsFromEnv()).toThrow());
  });
});
