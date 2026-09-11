import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlockForTests, withFileLock } from "../utils/file-lock";
import { CHILD_PROCESS_TEST_BUDGET_MS, CHILD_PROCESS_TIMEOUT_MS } from "./test-proc";

const HOLDER = join(import.meta.dir, "fixtures/file-lock-holder.ts");

/**
 * Start a separate process holding the lock; resolves once it has it. The child
 * is killed at CHILD_PROCESS_TIMEOUT_MS no matter what, and waiting for its
 * "locked" line gives up at the same deadline.
 */
async function holdInAnotherProcess(lockPath: string, holdMs: number) {
  const child = Bun.spawn([process.execPath, HOLDER, lockPath, String(holdMs)], {
    stdout: "pipe",
    stderr: "inherit",
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const reader = child.stdout.getReader();
  const deadline = Date.now() + CHILD_PROCESS_TIMEOUT_MS;
  let out = "";
  while (!out.includes("locked")) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(0, deadline - Date.now())).then(() => "timeout" as const),
    ]);
    if (next === "timeout" || next.done) {
      child.kill("SIGKILL");
      throw new Error(`holder did not lock: ${out}`);
    }
    out += new TextDecoder().decode(next.value);
  }
  reader.releaseLock();
  return child;
}

describe("withFileLock (kernel flock)", () => {
  let root: string;
  let lock: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "file-lock-"));
    lock = join(root, "nested/dir/test.lock"); // parent created on demand
  });

  afterEach(async () => {
    setFlockForTests(undefined);
    await rm(root, { recursive: true, force: true });
  });

  test("serializes concurrent holders", async () => {
    const events: string[] = [];
    const hold = (name: string) =>
      withFileLock(lock, async () => {
        events.push(`${name}:in`);
        await Bun.sleep(50);
        events.push(`${name}:out`);
      });

    await Promise.all([hold("a"), hold("b")]);

    expect(events).toHaveLength(4);
    expect(events[1]).toBe(events[0]?.replace(":in", ":out")); // no overlap
  });

  test(
    "a live holder is never robbed, however old its lock file looks",
    async () => {
      // The previous lock broke any lock file older than 30 s. Backdate the file
      // while a live process holds it: nothing may take it over.
      const holder = await holdInAnotherProcess(lock, 2_000);
      try {
        const longAgo = new Date(0);
        await utimes(lock, longAgo, longAgo);

        const whileHeld = await withFileLock(lock, async () => "ran", { waitMs: 300 });
        expect(whileHeld).toEqual({ acquired: false, reason: "busy" });

        await holder.exited;
        expect(await withFileLock(lock, async () => "ran", { waitMs: 1_000 })).toEqual({
          acquired: true,
          value: "ran",
        });
      } finally {
        holder.kill("SIGKILL");
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a holder killed with SIGKILL releases the lock",
    async () => {
      const holder = await holdInAnotherProcess(lock, 60_000);
      try {
        holder.kill("SIGKILL");
        await holder.exited;

        expect(await withFileLock(lock, async () => "ran", { waitMs: 1_000 })).toEqual({
          acquired: true,
          value: "ran",
        });
      } finally {
        holder.kill("SIGKILL");
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test("releases the lock when fn throws, and never deletes the lock file", async () => {
    await expect(
      withFileLock(lock, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await Bun.file(lock).exists()).toBe(true); // unlinking would allow a second inode
    expect(await withFileLock(lock, async () => "again", { waitMs: 100 })).toEqual({
      acquired: true,
      value: "again",
    });
  });

  test("reports an unusable lock path as an error, not as busy", async () => {
    await Bun.write(join(root, "file"), "not a directory");
    const result = await withFileLock(join(root, "file/test.lock"), async () => "ran");

    expect(result).toMatchObject({ acquired: false, reason: "error" });
  });

  test("without flock on the platform it never runs fn", async () => {
    setFlockForTests(null);
    let ran = false;
    const result = await withFileLock(lock, async () => {
      ran = true;
    });

    expect(result).toEqual({ acquired: false, reason: "unsupported" });
    expect(ran).toBe(false);
  });
});
