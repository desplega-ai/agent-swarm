import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyExit,
  NativeScriptExecutor,
  writeBareImportShim,
  writeBareImportShims,
} from "../scripts-runtime/executors/native";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const defaultResources = {
  memoryMb: 2048,
  cpuTimeSec: 20,
  wallClockMs: 15_000,
  maxStdoutBytes: 1_048_576,
  maxProcs: 64,
  maxFileBytes: 10 * 1024 * 1024,
  maxFdCount: 64,
};

const defaultConfigPayload = {
  system: {
    apiKey: { value: "test-key", isSecret: true },
    agentId: { value: "agent-1", isSecret: false },
    mcpBaseUrl: { value: "http://localhost:3013", isSecret: false },
  },
  user: {},
};

describe("NativeScriptExecutor startup overhead & shim reuse (#2008)", () => {
  test("writeBareImportShim creates package.json and index.ts in-process without shell spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-shim-unit-"));
    tempDirs.push(dir);
    const target = pathToFileURL(join(dir, "target.ts"));

    await writeBareImportShim(dir, "zod/mini", target);

    expect(existsSync(join(dir, "node_modules/zod/mini/package.json"))).toBe(true);
    expect(existsSync(join(dir, "node_modules/zod/mini/index.ts"))).toBe(true);
    const pkg = JSON.parse(await Bun.file(join(dir, "node_modules/zod/mini/package.json")).text());
    expect(pkg).toEqual({ type: "module", main: "index.ts" });
  });

  test("writeBareImportShims populates stdlib, swarm-sdk, zod, and zod/mini", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-shims-all-"));
    tempDirs.push(dir);

    await writeBareImportShims(dir);

    for (const mod of ["stdlib", "swarm-sdk", "zod", "zod/mini"]) {
      expect(existsSync(join(dir, "node_modules", mod, "package.json"))).toBe(true);
    }
  });

  test("classifyExit preserves retry-safety boundary around userCodeStarted and resource signals", () => {
    expect(classifyExit(134, false, false, false)).toBe("capacity_exceeded");
    expect(classifyExit(134, false, false, true)).toBe("eval_error");
    expect(classifyExit(1, true, false, true)).toBe("timeout");
    expect(classifyExit(1, false, true, true)).toBe("killed");
    expect(classifyExit(137, false, false, true)).toBe("killed");
    expect(classifyExit(0, false, false, true)).toBeUndefined();
  });

  spawnTest(
    "NativeScriptExecutor resolves bare imports across repeated runs and cleans up tmpdir",
    async () => {
      const executor = new NativeScriptExecutor();

      const first = await executor.run({
        source: `
        import { z } from "zod";
        export const argsSchema = z.object({ count: z.number() });
        export default async (args: { count: number }) => ({ doubled: args.count * 2 });
      `,
        args: { count: 21 },
        configPayload: defaultConfigPayload,
        resources: defaultResources,
        fsMode: "none",
        network: "full",
      });

      expect(first.error, first.stderr).toBeUndefined();
      expect(first.exitCode).toBe(0);
      expect(first.result).toEqual({ doubled: 42 });

      const second = await executor.run({
        source: `
        import { table } from "stdlib";
        export default async () => table([{ a: 1 }]);
      `,
        args: {},
        configPayload: defaultConfigPayload,
        resources: defaultResources,
        fsMode: "none",
        network: "full",
      });

      expect(second.error).toBeUndefined();
      expect(second.exitCode).toBe(0);
      expect(typeof second.result).toBe("string");
    },
  );

  spawnTest(
    "NativeScriptExecutor isolates global state and per-run TMPDIR across sequential runs",
    async () => {
      const executor = new NativeScriptExecutor();

      const run1 = await executor.run({
        source: `
        export default async () => {
          (globalThis as any).__leaked = "secret-from-run-1";
          const tmp = process.env.TMPDIR!;
          await Bun.write(tmp + "/marker.txt", "run1");
          return { tmp };
        };
      `,
        args: null,
        configPayload: defaultConfigPayload,
        resources: defaultResources,
        fsMode: "none",
        network: "full",
      });

      expect(run1.error, run1.stderr).toBeUndefined();
      const firstTmp = (run1.result as { tmp: string }).tmp;
      expect(existsSync(firstTmp)).toBe(false);

      const run2 = await executor.run({
        source: `
        export default async () => {
          const tmp = process.env.TMPDIR!;
          const hasMarker = await Bun.file(tmp + "/marker.txt").exists();
          return { leaked: (globalThis as any).__leaked ?? null, hasMarker, tmp };
        };
      `,
        args: null,
        configPayload: defaultConfigPayload,
        resources: defaultResources,
        fsMode: "none",
        network: "full",
      });

      expect(run2.error, run2.stderr).toBeUndefined();
      const secondResult = run2.result as { leaked: unknown; hasMarker: boolean; tmp: string };
      expect(secondResult.leaked).toBeNull();
      expect(secondResult.hasMarker).toBe(false);
      expect(secondResult.tmp).not.toBe(firstTmp);
    },
  );

  spawnTest("NativeScriptExecutor enforces wallClockMs timeout", async () => {
    const executor = new NativeScriptExecutor();

    const out = await executor.run({
      source: `
        export default async () => {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return "unreachable";
        };
      `,
      args: null,
      configPayload: defaultConfigPayload,
      resources: { ...defaultResources, wallClockMs: 250 },
      fsMode: "none",
      network: "full",
    });

    expect(out.error).toBe("timeout");
    expect(out.result).toBeUndefined();
  });

  spawnTest("NativeScriptExecutor respects pre-aborted signal without spawning child", async () => {
    const executor = new NativeScriptExecutor();
    const controller = new AbortController();
    controller.abort();

    const out = await executor.run({
      source: "export default async () => 1;",
      args: null,
      configPayload: defaultConfigPayload,
      resources: defaultResources,
      fsMode: "none",
      network: "full",
      signal: controller.signal,
    });

    expect(out.error).toBe("killed");
    expect(out.exitCode).toBe(1);
  });

  spawnTest("NativeScriptExecutor cancels an in-flight script when signal aborts", async () => {
    const executor = new NativeScriptExecutor();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const out = await executor.run({
      source: `
        export default async () => {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return "unreachable";
        };
      `,
      args: null,
      configPayload: defaultConfigPayload,
      resources: defaultResources,
      fsMode: "none",
      network: "full",
      signal: controller.signal,
    });

    expect(out.error).toBe("killed");
    expect(out.result).toBeUndefined();
  });

  spawnTest("NativeScriptExecutor enforces maxStdoutBytes truncation resource limit", async () => {
    const executor = new NativeScriptExecutor();

    const out = await executor.run({
      source: `
        export default async () => {
          console.log("x".repeat(4096));
          return { ok: true };
        };
      `,
      args: null,
      configPayload: defaultConfigPayload,
      resources: { ...defaultResources, maxStdoutBytes: 512 },
      fsMode: "none",
      network: "full",
    });

    expect(out.error, out.stderr).toBeUndefined();
    expect(out.truncated.stdout).toBe(true);
    expect(out.stdout.length).toBeLessThanOrEqual(512);
    expect(out.result).toEqual({ ok: true });
  });
});
