import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeScriptExecutor, readRunDirFile } from "../scripts-runtime/executors/native";
import type { ExecutorInput } from "../scripts-runtime/executors/types";
import {
  buildSandboxedCommand,
  DEFAULT_SANDBOX_LIMITS,
  resolveSandboxIdentity,
  UNPRIVILEGED_SANDBOX_IDENTITY,
} from "../utils/sandboxed-process";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { runChild } from "./test-proc";

const TEST_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp" };
const INNER = ["bun", "run", "/tmp/script.ts"];

// Launchers that actually confine a child: privilege drop, namespaces, chroot,
// syscall filters. ulimits and `env -i` bound resources and env only.
const ISOLATION_LAUNCHERS = [
  "unshare",
  "nsjail",
  "bwrap",
  "firejail",
  "chroot",
  "setpriv",
  "setuidgid",
  "runuser",
  "su ",
  "sudo ",
  "seccomp",
] as const;

function nativeCommandAs(euid: number): string {
  const runAs = resolveSandboxIdentity(euid, () => true);
  return buildSandboxedCommand(INNER, TEST_ENV, DEFAULT_SANDBOX_LIMITS, "inline", runAs).join(" ");
}

describe("native script sandbox identity", () => {
  test("an API running as root confines the script child to an unprivileged identity", () => {
    const flat = nativeCommandAs(0);

    expect(ISOLATION_LAUNCHERS.some((launcher) => flat.includes(launcher))).toBe(true);
    expect(flat).toContain(
      `setpriv --reuid=${UNPRIVILEGED_SANDBOX_IDENTITY.uid} --regid=${UNPRIVILEGED_SANDBOX_IDENTITY.gid} --clear-groups --no-new-privs env -i`,
    );
    // ulimits are applied before the switch, as the caller.
    expect(flat.indexOf("ulimit -v")).toBeLessThan(flat.indexOf("setpriv"));
  });

  test("control: resource ulimits stay in the prelude", () => {
    const flat = nativeCommandAs(0);

    expect(flat).toContain("ulimit -v");
    expect(flat).toContain("ulimit -u");
  });

  test("a non-root API has no identity to drop to and keeps the command unchanged", () => {
    expect(resolveSandboxIdentity(1000, () => true)).toBeUndefined();
    expect(nativeCommandAs(1000)).toBe(buildSandboxedCommand(INNER, TEST_ENV).join(" "));
  });

  test("root without setpriv falls back to the current command", () => {
    expect(resolveSandboxIdentity(0, () => false)).toBeUndefined();
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runNative(source: string, args: unknown) {
  const input: ExecutorInput = {
    source,
    args,
    configPayload: {
      system: {
        apiKey: { value: "test-key", isSecret: true },
        agentId: { value: "agent-1", isSecret: false },
        mcpBaseUrl: { value: "http://localhost:3013", isSecret: false },
      },
      user: {},
    },
    resources: {
      memoryMb: 2048,
      cpuTimeSec: 20,
      wallClockMs: 15_000,
      maxStdoutBytes: 1_048_576,
      maxProcs: 64,
      maxFileBytes: 10 * 1024 * 1024,
      maxFdCount: 64,
    },
    fsMode: "none",
    network: "full",
  };
  return new NativeScriptExecutor().run(input);
}

// The script swaps its result file for a link to a file outside the run dir,
// then exits before the harness writes the real result.
const PLANT_RESULT_LINK = `
  import { symlinkSync } from "node:fs";
  export default async (args: { target: string }) => {
    symlinkSync(args.target, process.env.SWARM_SCRIPT_RESULT_FILE!);
    process.exit(0);
  };
`;

const PLANT_ERROR_LINK = `
  import { symlinkSync } from "node:fs";
  export default async (args: { target: string }) => {
    symlinkSync(args.target, process.env.SWARM_SCRIPT_ERROR_FILE!);
    process.exit(3);
  };
`;

describe("run dir files the child controls", () => {
  const cap = { maxBytes: 1024 };

  test("control: a regular file the child wrote is read", async () => {
    const dir = tempDir("run-dir-read-");
    writeFileSync(join(dir, "result.json"), '{"ok":true}');

    expect(await readRunDirFile(join(dir, "result.json"), cap)).toBe('{"ok":true}');
  });

  test("a symlink is not followed", async () => {
    const dir = tempDir("run-dir-read-");
    const outside = join(tempDir("run-dir-outside-"), "outside.json");
    writeFileSync(outside, '{"outside":"api-readable"}');
    symlinkSync(outside, join(dir, "result.json"));

    expect(await readRunDirFile(join(dir, "result.json"), cap)).toBeUndefined();
  });

  test("a FIFO reads as absent instead of blocking", async () => {
    const dir = tempDir("run-dir-read-");
    const fifo = join(dir, "result.json");
    expect((await runChild(["mkfifo", fifo])).exitCode).toBe(0);

    expect(await readRunDirFile(fifo, cap)).toBeUndefined();
  });

  test("a file over the size cap reads as absent", async () => {
    const dir = tempDir("run-dir-read-");
    writeFileSync(join(dir, "result.json"), "x".repeat(cap.maxBytes + 1));

    expect(await readRunDirFile(join(dir, "result.json"), cap)).toBeUndefined();
  });

  test("a file owned by another uid reads as absent when an owner is required", async () => {
    const dir = tempDir("run-dir-read-");
    const path = join(dir, "result.json");
    writeFileSync(path, "{}");
    const uid = process.getuid?.() ?? 0;

    expect(await readRunDirFile(path, { ...cap, ownerUid: uid })).toBe("{}");
    expect(await readRunDirFile(path, { ...cap, ownerUid: uid + 1 })).toBeUndefined();
  });

  test("a hard link to a file the child does not own reads as absent", async () => {
    const dir = tempDir("run-dir-read-");
    const outside = join(tempDir("run-dir-outside-"), "outside.json");
    writeFileSync(outside, "{}");
    linkSync(outside, join(dir, "result.json"));
    const uid = process.getuid?.() ?? 0;

    // Same inode, so only the owner check can tell it apart.
    expect(await readRunDirFile(join(dir, "result.json"), { ...cap, ownerUid: uid + 1 })).toBe(
      undefined,
    );
  });
});

const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS || process.platform === "win32");

describe("native executor reads of the run dir", () => {
  spawnTest("a result file swapped for a symlink returns no result", async () => {
    const outside = join(tempDir("run-dir-outside-"), "outside.json");
    writeFileSync(outside, '{"outside":"api-readable"}');

    const out = await runNative(PLANT_RESULT_LINK, { target: outside });

    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.result).toBeUndefined();
  });

  spawnTest("a non-JSON symlink target does not leak into stderr", async () => {
    const outside = join(tempDir("run-dir-outside-"), "outside.txt");
    writeFileSync(outside, "leakedtoken rest-of-file");

    const out = await runNative(PLANT_RESULT_LINK, { target: outside });

    expect(out.stderr).not.toContain("leakedtoken");
    expect(out.result).toBeUndefined();
  });

  spawnTest("an error file swapped for a symlink returns no runtime error", async () => {
    const outside = join(tempDir("run-dir-outside-"), "outside.json");
    writeFileSync(outside, '{"name":"Outside","message":"api-readable"}');

    const out = await runNative(PLANT_ERROR_LINK, { target: outside });

    expect(out.exitCode).toBe(3);
    expect(out.runtimeError).toBeUndefined();
  });
});

// Only a root API switches identity, so only a root test run can observe it.
const rootSpawnTest = test.skipIf(
  SKIP_SANDBOX_SPAWN_TESTS || process.geteuid?.() !== 0 || Bun.which("setpriv") === null,
);

describe("native script sandbox identity at runtime", () => {
  rootSpawnTest("script code cannot read a root-owned 0600 file", async () => {
    const dir = tempDir("native-identity-");
    // Traversable dir, so the file mode alone is the barrier.
    chmodSync(dir, 0o755);
    const privateFile = join(dir, "private.key");
    writeFileSync(privateFile, "dummy");
    chmodSync(privateFile, 0o600);

    const out = await runNative(
      `
        export default async (args: { path: string }) => {
          let readable = false;
          try {
            await Bun.file(args.path).text();
            readable = true;
          } catch {}
          return { uid: process.getuid(), readable };
        };
      `,
      { path: privateFile },
    );

    expect(out.error, out.stderr).toBeUndefined();
    expect(out.result).toEqual({ uid: UNPRIVILEGED_SANDBOX_IDENTITY.uid, readable: false });
  });

  rootSpawnTest("a result linked to a root-owned 0600 file returns no result", async () => {
    const dir = tempDir("native-identity-");
    chmodSync(dir, 0o755);
    const privateFile = join(dir, "private.json");
    writeFileSync(privateFile, '{"secret":"root-only"}');
    chmodSync(privateFile, 0o600);

    const out = await runNative(PLANT_RESULT_LINK, { target: privateFile });

    expect(out.exitCode, out.stderr).toBe(0);
    expect(out.result).toBeUndefined();
  });
});
