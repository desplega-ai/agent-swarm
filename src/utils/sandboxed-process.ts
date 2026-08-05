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
 * Bun's Linux runtime reserves several GB of virtual address space at
 * startup, so any sandboxed command whose argv[0] is `bun` needs a much
 * higher RLIMIT_AS floor than a plain shell/python process or the harness is
 * killed before user code ever runs. `buildSandboxedCommand` applies this
 * automatically — callers don't need to special-case it.
 */
export const BUN_SANDBOX_VIRTUAL_MEMORY_MB = 4096;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Wrap `innerCommand` in a POSIX `sh -c` prelude that applies the resource
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
 * No-ops (returns `innerCommand` unchanged) on win32, where `ulimit`/`env -i`
 * don't exist — matches the existing native.ts behavior.
 */
export function buildSandboxedCommand(
  innerCommand: readonly string[],
  env: Readonly<Record<string, string>>,
  limits: SandboxResourceLimits = DEFAULT_SANDBOX_LIMITS,
): string[] {
  if (process.platform === "win32") return [...innerCommand];

  const virtualMemoryMb =
    innerCommand[0] === "bun"
      ? Math.max(limits.virtualMemoryMb, BUN_SANDBOX_VIRTUAL_MEMORY_MB)
      : limits.virtualMemoryMb;

  const ulimits = [
    `ulimit -v ${Math.floor(virtualMemoryMb * 1024)} 2>/dev/null || true`,
    `ulimit -t ${limits.cpuTimeSec} 2>/dev/null || true`,
    `ulimit -u ${limits.maxProcs} 2>/dev/null || true`,
    `ulimit -f ${limits.maxFileKb} 2>/dev/null || true`,
    `ulimit -n ${limits.maxFdCount} 2>/dev/null || true`,
  ].join("; ");

  const envAssignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const quotedInner = innerCommand.map(shellQuote).join(" ");

  return ["sh", "-c", `${ulimits}; exec env -i ${envAssignments} ${quotedInner}`];
}

export type CappedText = { text: string; truncated: boolean };

/**
 * Read a stream up to `maxBytes`, discarding (but noting) any overflow.
 * Prevents an unsandboxed-output path from letting a spawned child OOM the
 * parent by writing unbounded stdout/stderr.
 */
export async function readStreamCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<CappedText> {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    const remaining = maxBytes - total;
    if (remaining > 0) {
      const accepted = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(accepted);
      total += accepted.byteLength;
    }
    if (value.byteLength > remaining) truncated = true;
  }

  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}
