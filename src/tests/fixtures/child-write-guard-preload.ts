/**
 * Loaded through BUN_OPTIONS by every Bun process the test suite spawns
 * (`child-write-guard.ts`). A write to `/workspace/`, the identity baselines
 * file or its lock fails with the guard message, as it would on a CI runner
 * without those paths, instead of overwriting the worker running the suite.
 */
import { mock } from "bun:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import promises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { propagateWriteGuardToChildren, WRITE_GUARD_PATHS_ENV } from "./child-write-guard";
import { installProfileWriteGuard } from "./profile-write-guard";

const injected = process.env[WRITE_GUARD_PATHS_ENV];
const protectedPaths = injected ? JSON.parse(injected) : undefined;
// The sandbox is the checkout: a worker's clone lives under /workspace/personal,
// and the suite's children write logs and fixtures there. Never when the
// checkout would contain a profile file (a clone at /workspace itself).
const checkout = resolve(import.meta.dir, "..", "..", "..");
const containsProfile = ["/workspace/SOUL.md", "/tmp/identity-baselines.json"]
  .concat(
    protectedPaths ? [join(protectedPaths.workspace, "SOUL.md"), protectedPaths.baselines] : [],
  )
  .some((path) => resolve(path).startsWith(checkout + sep));
installProfileWriteGuard(
  containsProfile ? join(tmpdir(), `write-guard-no-sandbox-${crypto.randomUUID()}`) : checkout,
  protectedPaths,
  "throw",
);

// Patching the module objects misses ESM named imports (`import { writeFile }
// from "node:fs/promises"`), which bind before any preload code runs. Serve
// the patched objects as the modules themselves so those bindings see the guard.
for (const name of ["node:fs/promises", "fs/promises"]) {
  mock.module(name, () => ({ ...promises, default: promises }));
}
for (const name of ["node:fs", "fs"]) {
  mock.module(name, () => ({ ...fs, default: fs, promises }));
}

propagateWriteGuardToChildren();
for (const name of ["node:child_process", "child_process"]) {
  mock.module(name, () => ({ ...childProcess, default: childProcess }));
}
