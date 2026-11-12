/**
 * Carry the profile write guard into every process the test suite spawns
 * (agent-swarm-ops#884). Suites such as api-drain-worker-e2e launch the real CLI
 * with an explicit env that does not inherit ours, so the guard travels in that
 * env: Bun reads `BUN_OPTIONS` at startup, and `--preload` there makes any Bun
 * child load `child-write-guard-preload.ts` before its entrypoint. The preload
 * applies this same propagation, so grandchildren are covered too.
 *
 * Test-only: nothing in the runner or CLI reads these variables.
 */
import childProcess from "node:child_process";
import { join } from "node:path";

/** Test-only env var: extra protected paths (a simulated workspace and baselines file), as JSON. */
export const WRITE_GUARD_PATHS_ENV = "AGENT_SWARM_TEST_WRITE_GUARD_PATHS";
export const WRITE_GUARD_PRELOAD = join(import.meta.dir, "child-write-guard-preload.ts");
const PRELOAD_FLAG = `--preload=${WRITE_GUARD_PRELOAD}`;

type Env = Record<string, string | undefined>;

/** A child env that loads the guard; an absent env means the child inherits ours. */
export function withWriteGuard(env: Env | undefined): Env {
  const next: Env = { ...(env ?? process.env) };
  const options = next.BUN_OPTIONS ?? "";
  if (!options.includes(PRELOAD_FLAG)) next.BUN_OPTIONS = `${options} ${PRELOAD_FLAG}`.trim();
  if (next[WRITE_GUARD_PATHS_ENV] === undefined && process.env[WRITE_GUARD_PATHS_ENV]) {
    next[WRITE_GUARD_PATHS_ENV] = process.env[WRITE_GUARD_PATHS_ENV];
  }
  return next;
}

function guardOptions(options: unknown): unknown {
  if (!options || typeof options !== "object" || Array.isArray(options)) return options;
  const env = (options as { env?: Env }).env;
  return env === undefined ? options : { ...options, env: withWriteGuard(env) };
}

let installed = false;

export function propagateWriteGuardToChildren(): void {
  if (installed) return;
  installed = true;
  // Children that inherit our env (no `env` option, Bun.$, child_process defaults).
  process.env.BUN_OPTIONS = withWriteGuard(process.env).BUN_OPTIONS;

  // Children given an explicit env: Bun.spawn(cmd, opts) and Bun.spawn({ cmd, ...opts }).
  for (const name of ["spawn", "spawnSync"] as const) {
    const original = Bun[name] as (...args: unknown[]) => unknown;
    (Bun as unknown as Record<string, unknown>)[name] = (...args: unknown[]) =>
      Array.isArray(args[0])
        ? original(args[0], guardOptions(args[1] ?? {}), ...args.slice(2))
        : original(guardOptions(args[0]), ...args.slice(1));
  }

  // node:child_process: the options object is the last plain object argument.
  const functions = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ]) {
    const original = functions[name];
    if (typeof original !== "function") continue;
    functions[name] = (...args: unknown[]) => {
      const index = args.findLastIndex(
        (arg) => arg !== null && typeof arg === "object" && !Array.isArray(arg),
      );
      if (index >= 0) args[index] = guardOptions(args[index]);
      return original.apply(childProcess, args);
    };
  }
}
