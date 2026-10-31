import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

/**
 * Real-Docker check for persistent runtime pool caches (agent-swarm #2577).
 *
 * Needs a Docker daemon and the sleeper image, so it skips without one:
 *   docker build -t e2e-gap-sleeper:1 - <<< $'FROM alpine:3.20\nCMD ["sleep","3600"]'
 *   bun run e2e --only gap-runtime-pool-cache --sut-env RUNTIME_POOLS_ENABLED=true
 */
const IMAGE = process.env.E2E_GAP_SLEEPER_IMAGE ?? "e2e-gap-sleeper:1";
const MOUNT = "/cache";

async function docker(...args: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, out: (out + err).trim() };
}

function entityId(value: unknown): string {
  const id = asRecord(value).id;
  expect(typeof id === "string", "Entity response has no id");
  return id;
}

type Mount = { Type?: string; Name?: string; Destination?: string };

async function runtimeContainers(poolId: string): Promise<string[]> {
  const listed = await docker(
    "ps",
    "-aq",
    "--filter",
    `label=swarm.pool-id=${poolId}`,
    "--no-trunc",
  );
  return listed.out.split("\n").filter(Boolean);
}

async function mountsOf(containerId: string): Promise<Mount[]> {
  const inspected = await docker("inspect", "--format", "{{json .Mounts}}", containerId);
  expect(inspected.ok, `docker inspect failed: ${inspected.out}`);
  return JSON.parse(inspected.out) as Mount[];
}

export const gapRuntimePoolCache: Scenario = {
  name: "gap-runtime-pool-cache",
  order: 1200,
  groups: ["gap"],
  async run(ctx: ScenarioContext) {
    const status = asRecord(asRecord((await ctx.api("GET", "/status")).json).runtime_pools);
    if (status.enabled !== true) throw new Error("Start the SUT with RUNTIME_POOLS_ENABLED=true");
    const daemon = await docker("version", "--format", "{{.Server.Version}}");
    expect(daemon.ok, `No Docker daemon: ${daemon.out}`);
    const image = await docker("image", "inspect", IMAGE, "--format", "{{.Id}}");
    expect(image.ok, `Missing image ${IMAGE}: ${image.out}`);

    const builtin = await ctx.api("GET", "/api/runtime-controllers/builtin-docker");
    expectStatus(builtin, [200], "read builtin docker controller");
    expect(
      asRecord(asRecord(builtin.json).controller).status === "online",
      "builtin-docker controller is not online",
    );

    const poolIds: string[] = [];
    const taskIds: string[] = [];
    let volume: string | undefined;
    try {
      // 1. Validation: unsupported providers and protected paths are rejected.
      for (const [kind, controller] of [
        ["static", "builtin-static"],
        ["e2b", "builtin-e2b"],
      ] as const) {
        const rejected = await ctx.api("POST", "/api/runtime-pools", {
          body: {
            name: `gap-reject-${kind}-${ctx.nonce}`,
            kind,
            placements: [controller],
            image: "x",
            cache: { mountPath: MOUNT },
          },
        });
        expect(
          rejected.status >= 400 && rejected.status < 500,
          `${kind} pool with a cache returned ${rejected.status}, expected 4xx`,
        );
        expect(
          JSON.stringify(rejected.json).includes("does not support persistent pool caches"),
          `${kind} rejection has the wrong reason: ${JSON.stringify(rejected.json)}`,
        );
      }
      ctx.log("gap-runtime-pool-cache: static and e2b pools reject cache");
      for (const mountPath of ["/home/worker/.claude", "/workspace/personal", "/a/../etc"]) {
        const rejected = await ctx.api("POST", "/api/runtime-pools", {
          body: {
            name: `gap-path-${ctx.nonce}`,
            kind: "docker",
            placements: ["builtin-docker"],
            image: IMAGE,
            cache: { mountPath },
          },
        });
        expectStatus(rejected, [400], `protected mount path ${mountPath}`);
      }
      const foreignKey = await ctx.api("POST", "/api/runtime-pools", {
        body: {
          name: `gap-key-${ctx.nonce}`,
          kind: "docker",
          placements: ["builtin-docker"],
          image: IMAGE,
          cache: { mountPath: MOUNT, key: "foreign-volume" },
        },
      });
      expectStatus(foreignKey, [400], "operator-chosen volume key");

      // 2. Negative control: a pool without cache mounts nothing.
      const plain = await ctx.api("POST", "/api/runtime-pools", {
        body: {
          name: `gap-plain-${ctx.nonce}`,
          kind: "docker",
          placements: ["builtin-docker"],
          image: IMAGE,
          delivery: "push",
          lifecycle: "per-task",
          maxRuntimes: 1,
        },
      });
      expectStatus(plain, [200], "create pool without cache");
      const plainId = entityId(asRecord(plain.json).pool);
      poolIds.push(plainId);
      expect(asRecord(asRecord(plain.json).pool).cache === null, "Plain pool has a cache");

      // 3. Cached pool: public shape carries mountPath only.
      const cached = await ctx.api("POST", "/api/runtime-pools", {
        body: {
          name: `gap-cache-${ctx.nonce}`,
          kind: "docker",
          placements: ["builtin-docker"],
          image: IMAGE,
          delivery: "push",
          lifecycle: "per-task",
          maxRuntimes: 1,
          cache: { mountPath: MOUNT },
        },
      });
      expectStatus(cached, [200], "create cached docker pool");
      const poolId = entityId(asRecord(cached.json).pool);
      poolIds.push(poolId);
      const cacheShape = asRecord(asRecord(cached.json).pool).cache;
      expect(
        JSON.stringify(cacheShape) === JSON.stringify({ mountPath: MOUNT }),
        `Public cache shape leaks internals: ${JSON.stringify(cacheShape)}`,
      );

      const wake = async (poolIdFor: string, label: string): Promise<string> => {
        const agent = await ctx.api("POST", `/api/runtime-pools/${poolIdFor}/agents`, {
          body: { name: `gap-${label}-${ctx.nonce}`, maxTasks: 1 },
        });
        expectStatus(agent, [200], `create ${label} pool agent`);
        const task = await ctx.api("POST", "/api/tasks", {
          body: { task: `Wake ${label}`, followUpConfig: { disabled: true } },
        });
        expectStatus(task, [201], `create ${label} task`);
        taskIds.push(entityId(task.json));
        // Tier-two routing assigns the sleeping agent after the wake grace, then the
        // supervisor provisions a runtime.
        const appeared = await pollUntil(
          async () => (await runtimeContainers(poolIdFor)).length > 0,
          120_000,
          1000,
        );
        expect(appeared, `${label}: supervisor never started a container`);
        const [containerId] = await runtimeContainers(poolIdFor);
        return containerId!;
      };

      // Run 1: write a marker into the cache.
      const first = await wake(poolId, "first");
      const firstMounts = await mountsOf(first);
      const cacheMount = firstMounts.find((m) => m.Destination === MOUNT);
      expect(
        cacheMount?.Type === "volume" && !!cacheMount.Name?.startsWith(`swarm-cache-${poolId}`),
        `Runtime 1 has no pool cache volume at ${MOUNT}: ${JSON.stringify(firstMounts)}`,
      );
      volume = cacheMount!.Name!;
      const labels = await docker("volume", "inspect", volume, "--format", "{{json .Labels}}");
      expect(
        labels.ok && labels.out.includes('"swarm.cache":"true"'),
        `Cache volume is not labelled swarm.cache: ${labels.out}`,
      );
      const marker = `marker-${ctx.nonce}`;
      const wrote = await docker("exec", first, "sh", "-c", `echo ${marker} > ${MOUNT}/marker`);
      expect(wrote.ok, `Could not write to the cache: ${wrote.out}`);
      ctx.log(`gap-runtime-pool-cache: runtime 1 wrote ${MOUNT}/marker on volume ${volume}`);

      // Terminate runtime 1 (what a finished per-task runtime does) and confirm the volume stays.
      expect((await docker("rm", "-f", first)).ok, "Could not remove runtime 1");
      const kept = await docker("volume", "inspect", volume);
      expect(kept.ok, "Cache volume disappeared after its runtime was terminated");

      // Run 2: a new runtime mounts the same volume and sees the marker.
      for (const id of taskIds) await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} });
      const second = await wake(poolId, "second");
      expect(second !== first, "Second wake reused the first container");
      const secondMount = (await mountsOf(second)).find((m) => m.Destination === MOUNT);
      expect(
        secondMount?.Name === volume,
        `Runtime 2 mounted ${secondMount?.Name ?? "nothing"}, expected ${volume}`,
      );
      const read = await docker("exec", second, "cat", `${MOUNT}/marker`);
      expect(read.ok && read.out === marker, `Runtime 2 read "${read.out}", expected "${marker}"`);
      ctx.log("gap-runtime-pool-cache: runtime 2 read the marker written by runtime 1");

      // Negative control: the pool without cache mounts no pool volume.
      const control = await wake(plainId, "control");
      const controlMounts = await mountsOf(control);
      expect(
        !controlMounts.some((m) => m.Name?.startsWith("swarm-cache-") || m.Destination === MOUNT),
        `Pool without cache mounted a cache: ${JSON.stringify(controlMounts)}`,
      );

      // Disabling the cache retires the volume once its runtimes are gone.
      expect((await docker("rm", "-f", second)).ok, "Could not remove runtime 2");
      expectStatus(
        await ctx.api("PATCH", `/api/runtime-pools/${poolId}`, { body: { cache: null } }),
        [200],
        "disable cache",
      );
      const released = await pollUntil(
        async () => !(await docker("volume", "inspect", volume!)).ok,
        120_000,
        2000,
      );
      expect(released, `Cache volume ${volume} was not removed after the cache was disabled`);
      volume = undefined;
      ctx.log("gap-runtime-pool-cache: disabling the cache removed the volume");
    } finally {
      for (const id of taskIds) await ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} });
      for (const id of poolIds) {
        await ctx.api("PATCH", `/api/runtime-pools/${id}`, { body: { enabled: false } });
        for (const container of await runtimeContainers(id)) await docker("rm", "-f", container);
      }
      if (volume) await docker("volume", "rm", "-f", volume);
    }
  },
};
