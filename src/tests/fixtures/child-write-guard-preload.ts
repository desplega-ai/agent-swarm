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
import { join } from "node:path";
import { propagateWriteGuardToChildren, WRITE_GUARD_PATHS_ENV } from "./child-write-guard";
import { installProfileWriteGuard } from "./profile-write-guard";

const injected = process.env[WRITE_GUARD_PATHS_ENV];
installProfileWriteGuard(
  // No sandbox: a child of the suite writes nowhere under the protected paths.
  join(tmpdir(), `write-guard-no-sandbox-${crypto.randomUUID()}`),
  injected ? JSON.parse(injected) : undefined,
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
