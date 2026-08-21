/**
 * Shared sandbox for every code path that spawns a subprocess to run
 * user-supplied or attacker-influenceable source (inline scripts, durable
 * script workflow runs, workflow `script` nodes). One helper so the sandbox
 * posture — resource ulimits, a clean minimal environment, no raw secrets in
 * the child's env — is enforced identically everywhere instead of being
 * re-implemented (and re-forgotten) per call site.
 *
 * Mirrors the ulimit values CLAUDE.md documents for the inline scripts
 * runtime (`ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`) and the
 * `harnessCommand` implementation this was extracted from
 * (src/scripts-runtime/executors/native.ts).
 */

export interface SandboxResourceLimits {
  /** RLIMIT_AS ceiling, in MB. */
  virtualMemoryMb: number;
  /** RLIMIT_CPU ceiling, in seconds. */
  cpuTimeSec: number;
  /** RLIMIT_NPROC ceiling (process/thread count). */
  maxProcs: number;
  /** RLIMIT_FSIZE ceiling, in KB. */
  maxFileKb: number;
  /** RLIMIT_NOFILE ceiling (open file descriptor count). */
  maxFdCount: number;
}

/** CLAUDE.md-documented floor: `ulimit -v 524288 -t 60 -u 32 -f 65536 -n 64`. */
export const DEFAULT_SANDBOX_LIMITS: SandboxResourceLimits = {
  virtualMemoryMb: 512,
  cpuTimeSec: 60,
  maxProcs: 32,
  maxFileKb: 65536,
  maxFdCount: 64,
};

/**
 * Bun and Node reserve several GB of virtual address space and start runtime
 * threads before user code runs. Give their process trees enough RLIMIT_AS
 * and RLIMIT_NPROC headroom to boot while retaining the stricter defaults for
 * direct non-interpreter commands.
 */
export const BUN_SANDBOX_VIRTUAL_MEMORY_MB = 4096;
export const JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS = 512;

const JAVASCRIPT_RUNTIMES = new Set(["bun", "bunx", "node", "nodejs", "npx"]);
const SHELL_RUNTIMES = new Set(["bash", "dash", "sh"]);

function commandBasename(command: string): string {
  return command.slice(command.lastIndexOf("/") + 1);
}

function usesInterpreterSandboxProfile(innerCommand: readonly string[]): boolean {
  const runtime = commandBasename(innerCommand[0] ?? "");
  // A shell can invoke another interpreter through arbitrary valid shell
  // grammar (substitutions, functions, variables, heredocs, and more). Treat
  // the shell itself as the runtime boundary instead of letting untrusted
  // source text select its own resource profile through brittle parsing.
  return JAVASCRIPT_RUNTIMES.has(runtime) || SHELL_RUNTIMES.has(runtime);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Bun runtime flag: the child exits when its parent dies and SIGKILLs every
 * descendant when it exits. Closes the process-tree gap the ulimits alone
 * leave open (a harness that forks and is then killed on timeout used to
 * leave its grandchildren running). Bun ignores flags it does not know, so
 * older runtimes degrade to the previous behavior.
 */
export const BUN_NO_ORPHANS_FLAG = "--no-orphans";

function withBunNoOrphans(innerCommand: readonly string[]): string[] {
  if (commandBasename(innerCommand[0] ?? "") !== "bun") return [...innerCommand];
  if (innerCommand.includes(BUN_NO_ORPHANS_FLAG)) return [...innerCommand];
  return [innerCommand[0] as string, BUN_NO_ORPHANS_FLAG, ...innerCommand.slice(1)];
}

/**
 * Wrap `innerCommand` in a shell prelude that applies the resource
 * ulimits above, then `exec`s into a completely clean environment (`env -i`)
 * containing ONLY the entries in `env`. This is the enforcement point for
 * two invariants every spawn-user-code path must uphold:
 *
 *  1. Resource limits actually apply to the child (and everything it forks).
 *  2. The child never inherits the parent process's full `process.env` —
 *     callers must pass every env var the child legitimately needs
 *     (PATH/HOME/etc.) explicitly. In particular, never put a raw bearer
 *     token / API key in `env`; pass secrets over stdin instead so they
 *     never appear in `/proc/<pid>/environ` or a child's `process.env`.
 *
 * JavaScript-capable runtime trees use Bash intentionally: Ubuntu's `/bin/sh` is
 * dash, whose `ulimit` does not implement `-u` (RLIMIT_NPROC). Other commands
 * retain the existing POSIX-sh sandbox behavior and its strict profile. No-ops
 * (returns `innerCommand` unchanged) on win32, where `ulimit`/`env -i`
 * don't exist — matches the existing native.ts behavior. Because this no-op
 * means `env` is never applied on win32, callers MUST pass `env` itself
 * (not just `{ PATH }`) to `Bun.spawn` on that platform — use
 * `sandboxSpawnEnv(env)` for the `Bun.spawn` `env` option so both platforms
 * are handled correctly.
 */
export function buildSandboxedCommand(
  innerCommand: readonly string[],
  env: Readonly<Record<string, string>>,
  limits: SandboxResourceLimits = DEFAULT_SANDBOX_LIMITS,
): string[] {
  if (process.platform === "win32") return [...innerCommand];

  const usesInterpreterProfile = usesInterpreterSandboxProfile(innerCommand);
  const virtualMemoryMb = usesInterpreterProfile
    ? Math.max(limits.virtualMemoryMb, BUN_SANDBOX_VIRTUAL_MEMORY_MB)
    : limits.virtualMemoryMb;
  const maxProcs = usesInterpreterProfile
    ? Math.max(limits.maxProcs, JAVASCRIPT_RUNTIME_SANDBOX_MAX_PROCS)
    : limits.maxProcs;

  const ulimits = [
    `ulimit -v ${Math.floor(virtualMemoryMb * 1024)} 2>/dev/null || true`,
    `ulimit -t ${limits.cpuTimeSec} 2>/dev/null || true`,
    `ulimit -u ${maxProcs} 2>/dev/null || true`,
    `ulimit -f ${limits.maxFileKb} 2>/dev/null || true`,
    `ulimit -n ${limits.maxFdCount} 2>/dev/null || true`,
  ].join("; ");

  const envAssignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const quotedInner = withBunNoOrphans(innerCommand).map(shellQuote).join(" ");

  return [
    usesInterpreterProfile ? "bash" : "sh",
    "-c",
    `${ulimits}; exec env -i ${envAssignments} ${quotedInner}`,
  ];
}

/**
 * The env object callers should pass to `Bun.spawn`'s own `env` option,
 * alongside the command from `buildSandboxedCommand`.
 *
 * On POSIX, `buildSandboxedCommand` wraps the command in an `env -i` prelude
 * that injects `env` itself into the child — Bun.spawn only needs PATH to
 * locate the shell binary that runs the prelude.
 *
 * On win32, `buildSandboxedCommand` is a no-op (no `ulimit`/`env -i`), so
 * there is no prelude to inject `env` — it must go through Bun.spawn's own
 * `env` option directly, or the child gets none of it (every caller here
 * passes Bun.spawn only `{ PATH }` on the assumption the prelude supplies
 * the rest).
 */
export function sandboxSpawnEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return process.platform === "win32" ? { ...env } : { PATH: env.PATH ?? "" };
}

export type CappedText = { text: string; truncated: boolean };

/**
 * Mutable progress state for `readStreamCapped`, owned by the caller. Lets a
 * caller that races the read against a deadline (see
 * `src/workflows/executors/script.ts`) snapshot whatever has been read so
 * far via `snapshotCapped` even while the read promise is still pending —
 * e.g. because a leaked grandchild still holds the pipe's write end open.
 */
export interface CappedStreamState {
  chunks: Uint8Array[];
  total: number;
  truncated: boolean;
}

export function createCappedStreamState(): CappedStreamState {
  return { chunks: [], total: 0, truncated: false };
}

/** Snapshot whatever `readStreamCapped` has accumulated into `state` so far. */
export function snapshotCapped(state: CappedStreamState): CappedText {
  return { text: new TextDecoder().decode(Buffer.concat(state.chunks)), truncated: true };
}

/**
 * Read a stream up to `maxBytes`, discarding (but noting) any overflow.
 * Prevents an unsandboxed-output path from letting a spawned child OOM the
 * parent by writing unbounded stdout/stderr.
 *
 * Accepts an optional caller-owned `state` so the caller can snapshot
 * partial progress (via `snapshotCapped`) before this promise resolves.
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  state: CappedStreamState = createCappedStreamState(),
): Promise<CappedText> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = maxBytes - state.total;
    if (remaining > 0) {
      const accepted = value.byteLength > remaining ? value.slice(0, remaining) : value;
      state.chunks.push(accepted);
      state.total += accepted.byteLength;
    }
    if (value.byteLength > remaining) state.truncated = true;
  }

  return {
    text: new TextDecoder().decode(Buffer.concat(state.chunks)),
    truncated: state.truncated,
  };
}
