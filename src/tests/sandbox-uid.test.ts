import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfigValue } from "../be/swarm-config-guard";
import {
  _resetSandboxUidStateForTests,
  activeSandboxUidBase,
  chownForSandbox,
  createSandboxUidPool,
  DEFAULT_SANDBOX_UID_BASE,
  hasSandboxUidDropCaps,
  type ReapOutcome,
  reapUid,
  SANDBOX_UID_DROP_CAPS,
  type SandboxUser,
  sandboxUidBase,
  sandboxUidDropAvailable,
  sharedSandboxUser,
} from "../utils/sandbox-uid";

const reaped: SandboxUser[] = [];
const reap = async (user: SandboxUser): Promise<ReapOutcome> => {
  reaped.push(user);
  return "reaped";
};

afterEach(() => {
  reaped.length = 0;
  delete process.env.SCRIPT_SANDBOX_UID_BASE;
  _resetSandboxUidStateForTests();
});

describe("sandbox uid pool", () => {
  test("concurrent leases get distinct uids from the base", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 4, reap });
    const leases = await Promise.all([pool.lease(), pool.lease(), pool.lease()]);
    const uids = leases.map((lease) => lease.user.uid);
    expect(new Set(uids).size).toBe(3);
    for (const uid of uids) expect(uid >= 61000 && uid < 61004).toBe(true);
    for (const lease of leases) expect(lease.user.gid).toBe(lease.user.uid);
    expect(pool.inUse()).toBe(3);
  });

  test("release reaps the uid once, then frees the slot", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 2, reap });
    const lease = await pool.lease();
    await lease.release();
    await lease.release();
    expect(reaped).toEqual([lease.user]);
    expect(pool.inUse()).toBe(0);
  });

  test("hands out a just-released uid last", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 3, reap });
    const first = await pool.lease();
    await first.release();
    const second = await pool.lease();
    expect(second.user.uid).not.toBe(first.user.uid);
  });

  test("waits for a free slot instead of sharing a uid", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 1, reap });
    const held = await pool.lease();
    let granted: number | undefined;
    const waiting = pool.lease().then((lease) => {
      granted = lease.user.uid;
      return lease;
    });
    await Bun.sleep(20);
    expect(granted).toBeUndefined();
    await held.release();
    const next = await waiting;
    expect(next.user.uid).toBe(held.user.uid);
    expect(pool.inUse()).toBe(1);
  });

  test("an aborted wait rejects and leaves the queue clean", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 1, reap });
    const held = await pool.lease();
    const controller = new AbortController();
    const waiting = pool.lease(controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    await held.release();
    expect(pool.inUse()).toBe(0);
    const again = await pool.lease();
    expect(again.user.uid).toBe(61000);
  });
});

describe("sandbox uid reap failures", () => {
  test("an already-empty uid frees the slot", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 1, reap: async () => "empty" });
    const lease = await pool.lease();
    await lease.release();
    expect(pool.inUse()).toBe(0);
    expect(pool.quarantined()).toBe(0);
    expect((await pool.lease()).user.uid).toBe(61000);
  });

  test("a failed reap holds the uid back and wakes no waiter until a retry succeeds", async () => {
    const outcomes: ReapOutcome[] = ["failed", "empty"];
    const pool = createSandboxUidPool({
      base: 61000,
      size: 1,
      reap: async () => outcomes.shift() ?? "empty",
      reapRetryMs: 30,
    });
    const held = await pool.lease();
    let granted: number | undefined;
    const waiting = pool.lease().then((lease) => {
      granted = lease.user.uid;
      return lease;
    });
    await held.release();
    expect(pool.inUse()).toBe(1);
    expect(pool.quarantined()).toBe(1);
    await Bun.sleep(5);
    expect(granted).toBeUndefined();
    const next = await waiting;
    expect(next.user.uid).toBe(61000);
    expect(pool.quarantined()).toBe(0);
  });

  test("a reaper that throws counts as failed and release still resolves", async () => {
    const pool = createSandboxUidPool({
      base: 61000,
      size: 2,
      reap: async () => {
        throw new Error("spawn failed");
      },
      reapRetryMs: 60_000,
    });
    const lease = await pool.lease();
    await lease.release();
    expect(pool.inUse()).toBe(1);
    expect(pool.quarantined()).toBe(1);
    // The held-back uid is never handed out again.
    expect((await pool.lease()).user.uid).not.toBe(lease.user.uid);
  });

  test.skipIf(process.getuid?.() === 0)(
    "the real reaper reports failed when it cannot drop to the uid",
    async () => {
      expect(await reapUid({ uid: 61999, gid: 61999 })).toBe("failed");
    },
  );

  test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "the real reaper reports an unused uid as empty",
    async () => {
      expect(await reapUid({ uid: 61999, gid: 61999 })).toBe("empty");
    },
  );
});

describe("sandbox uid lease cancellation", () => {
  test("an already-aborted signal gets no lease, even with free slots", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 2, reap });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(pool.lease(controller.signal)).rejects.toThrow("cancelled");
    expect(pool.inUse()).toBe(0);
  });

  test("a waiter cancelled as it wakes passes the slot to the next waiter", async () => {
    const pool = createSandboxUidPool({ base: 61000, size: 1, reap });
    const held = await pool.lease();
    const controller = new AbortController();
    const { signal } = controller;
    // Abort lands between the wake-up and the waiter resuming: the pool
    // removes the abort listener on wake, so abort right after that.
    const removeListener = signal.removeEventListener.bind(signal);
    signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removeListener(...args);
      controller.abort(new Error("cancelled"));
    }) as AbortSignal["removeEventListener"];
    const cancelled = pool.lease(signal);
    const next = pool.lease();
    await held.release();
    await expect(cancelled).rejects.toThrow("cancelled");
    const lease = await Promise.race([next, Bun.sleep(500).then(() => undefined)]);
    expect(lease?.user.uid).toBe(61000);
    expect(pool.inUse()).toBe(1);
  });
});

describe("sandbox uid config", () => {
  test("a base below 1000 falls back to the default, so base - 1 is never root", () => {
    process.env.SCRIPT_SANDBOX_UID_BASE = "1";
    expect(sandboxUidBase()).toBe(DEFAULT_SANDBOX_UID_BASE);
    process.env.SCRIPT_SANDBOX_UID_BASE = "70000";
    expect(sandboxUidBase()).toBe(70000);
  });

  test("base 1000 is rejected and 1001 accepted, so the shared uid is at least 1000", () => {
    process.env.SCRIPT_SANDBOX_UID_BASE = "1000";
    expect(sandboxUidBase()).toBe(DEFAULT_SANDBOX_UID_BASE);
    process.env.SCRIPT_SANDBOX_UID_BASE = "1001";
    expect(sandboxUidBase()).toBe(1001);
    expect(validateConfigValue("SCRIPT_SANDBOX_UID_BASE", "1000")).toContain("1001");
    expect(validateConfigValue("SCRIPT_SANDBOX_UID_BASE", "1001")).toBeNull();
  });

  test("a live base change does not move the shared uid into the pool's range", () => {
    process.env.SCRIPT_SANDBOX_UID_BASE = "61000";
    expect(activeSandboxUidBase()).toBe(61000);
    // A config reload rewrites process.env; the pool keeps its startup base.
    process.env.SCRIPT_SANDBOX_UID_BASE = "61002";
    expect(activeSandboxUidBase()).toBe(61000);
    expect(sharedSandboxUser()).toEqual({ uid: 60999, gid: 60999 });
  });

  test.skipIf(process.platform === "win32")(
    "chownForSandbox makes the tree private even under umask 022",
    async () => {
      const previous = process.umask(0o022);
      const dir = await mkdtemp(join(tmpdir(), "sandbox-chown-"));
      try {
        await Bun.$`mkdir -p ${dir}/run/node_modules/stdlib`;
        await Bun.write(`${dir}/run/source.ts`, "export default 1;");
        await Bun.write(`${dir}/run/node_modules/stdlib/index.js`, "");
        expect((await stat(`${dir}/run`)).mode & 0o777).toBe(0o755);
        expect((await stat(`${dir}/run/source.ts`)).mode & 0o777).toBe(0o644);

        // chown to our own uid needs no privilege; root does the same for a sandbox uid.
        const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
        await chownForSandbox(`${dir}/run`, self);

        for (const path of ["run", "run/node_modules", "run/node_modules/stdlib"]) {
          expect((await stat(`${dir}/${path}`)).mode & 0o777).toBe(0o700);
        }
        for (const path of ["run/source.ts", "run/node_modules/stdlib/index.js"]) {
          expect((await stat(`${dir}/${path}`)).mode & 0o777).toBe(0o600);
        }
      } finally {
        process.umask(previous);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "uid drop is unavailable when the API is not root",
    async () => {
      expect(await sandboxUidDropAvailable()).toBe(false);
    },
  );
});

describe("sandbox uid capability check", () => {
  test("Docker's default root capability set is enough", () => {
    // Docker default: CHOWN DAC_OVERRIDE FOWNER FSETID KILL SETGID SETUID SETPCAP
    // NET_BIND_SERVICE NET_RAW SYS_CHROOT MKNOD AUDIT_WRITE SETFCAP.
    expect(hasSandboxUidDropCaps("Name:\tbun\nCapEff:\ta80425fb\n")).toBe(true);
  });

  test("a set without SETUID, or an empty set, is not", () => {
    expect(hasSandboxUidDropCaps("CapEff:\ta804257b\n")).toBe(false);
    expect(hasSandboxUidDropCaps("CapEff:\t0000000000000000\n")).toBe(false);
    expect(hasSandboxUidDropCaps("Name:\tbun\n")).toBe(false);
  });

  test("the minimal Helm add-back set is enough", () => {
    const bits = Object.values(SANDBOX_UID_DROP_CAPS).reduce((mask, bit) => mask | (1 << bit), 0);
    expect(hasSandboxUidDropCaps(`CapEff:\t${bits.toString(16).padStart(16, "0")}\n`)).toBe(true);
  });
});
