import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeScriptExecutor } from "../scripts-runtime/executors/native";
import {
  buildSandboxedCommand,
  DEFAULT_SANDBOX_LIMITS,
  resolveSandboxIdentity,
  UNPRIVILEGED_SANDBOX_IDENTITY,
} from "../utils/sandboxed-process";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

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

// Only a root API switches identity, so only a root test run can observe it.
const rootSpawnTest = test.skipIf(
  SKIP_SANDBOX_SPAWN_TESTS || process.geteuid?.() !== 0 || Bun.which("setpriv") === null,
);

describe("native script sandbox identity at runtime", () => {
  rootSpawnTest("script code cannot read a root-owned 0600 file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-identity-"));
    tempDirs.push(dir);
    // Traversable dir, so the file mode alone is the barrier.
    chmodSync(dir, 0o755);
    const privateFile = join(dir, "private.key");
    writeFileSync(privateFile, "dummy");
    chmodSync(privateFile, 0o600);

    const out = await new NativeScriptExecutor().run({
      source: `
        export default async (args: { path: string }) => {
          let readable = false;
          try {
            await Bun.file(args.path).text();
            readable = true;
          } catch {}
          return { uid: process.getuid(), readable };
        };
      `,
      args: { path: privateFile },
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
    });

    expect(out.error, out.stderr).toBeUndefined();
    expect(out.result).toEqual({ uid: UNPRIVILEGED_SANDBOX_IDENTITY.uid, readable: false });
  });
});
