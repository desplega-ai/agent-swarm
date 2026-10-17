import type { ExecutorInput, ExecutorOutput } from "./executors/types";
import type { SeccompPolicy } from "./sandbox-seccomp";

/**
 * Native script sandbox level, measured once per API process by running one
 * real script through the native executor:
 *
 * - `hardened`: the script ran under a sandbox uid and could not exec.
 * - `uid-only`: it ran under a sandbox uid, but the seccomp filter is missing.
 * - `none`: it ran as the API's own uid (seccomp alone does not protect the
 *   API's files, so it does not count as a level).
 */
export type ScriptSandboxLevel = "hardened" | "uid-only" | "none";

export type ScriptSandboxStatus = {
  level: ScriptSandboxLevel;
  uidDropped: boolean;
  seccomp: boolean;
  /** Set when the probe run itself failed. */
  error?: string;
};

const PROBE_SOURCE = `export default async function () {
  let spawn = "ok";
  try {
    await Bun.spawn(["true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
  } catch (error) {
    spawn = String(error?.code ?? "error");
  }
  return { uid: process.getuid(), spawn };
}
`;

export function sandboxProbeInput(): ExecutorInput {
  return {
    source: PROBE_SOURCE,
    args: {},
    // The probe never calls ctx; no credential goes in.
    configPayload: {
      system: {
        apiKey: { value: "", isSecret: true },
        agentId: { value: "script-sandbox-probe", isSecret: false },
        mcpBaseUrl: { value: "http://127.0.0.1:9", isSecret: false },
      },
      user: {},
    },
    resources: {
      memoryMb: 512,
      cpuTimeSec: 10,
      maxProcs: 32,
      maxFileBytes: 1024 * 1024,
      maxFdCount: 64,
      maxStdoutBytes: 64 * 1024,
      wallClockMs: 20_000,
    },
    fsMode: "none",
    network: "open",
  };
}

export function interpretSandboxProbe(
  output: ExecutorOutput,
  apiUid: number | undefined,
): ScriptSandboxStatus {
  const result = output.result as { uid?: unknown; spawn?: unknown } | undefined;
  if (output.error || typeof result?.uid !== "number") {
    return {
      level: "none",
      uidDropped: false,
      seccomp: false,
      error: output.error ?? "probe returned no uid",
    };
  }
  const uidDropped = result.uid !== 0 && result.uid !== apiUid;
  const seccomp = result.spawn === "EPERM";
  return {
    level: uidDropped ? (seccomp ? "hardened" : "uid-only") : "none",
    uidDropped,
    seccomp,
  };
}

export function requireNativeIsolation(): boolean {
  return process.env.SCRIPT_NATIVE_REQUIRE_ISOLATION === "true";
}

/** Operator switch for the exec-deny filter. Default on; only `"false"` turns it off. */
export function nativeExecDenyEnabled(): boolean {
  return process.env.SCRIPT_NATIVE_EXEC_DENY !== "false";
}

/**
 * The `SWARM_SCRIPT_SECCOMP` policy the native executor passes to the harness:
 * `off` when the operator disabled the exec-deny filter, `required` when
 * isolation is required, `best-effort` otherwise. With the filter off the
 * level can never be `hardened`, so `SCRIPT_NATIVE_REQUIRE_ISOLATION=true`
 * then refuses every native run.
 */
export function nativeSeccompPolicy(): SeccompPolicy {
  if (!nativeExecDenyEnabled()) return "off";
  return requireNativeIsolation() ? "required" : "best-effort";
}

/** Which script entrypoint `meta.scripts.sandbox` on /health measures. */
export const SCRIPT_SANDBOX_SCOPE = "native-executor";
