import { runScriptWithRunCredential } from "../be/scripts/run-credential";
import { scrubSecrets } from "../utils/secret-scrubber";

const PROBE_TIMEOUT_MS = 10_000;

/** Exercise the same executor and per-run credential as the gate, with a deadline even if the runner stalls. */
export async function probeScriptRunner(
  agentId: string,
  runner: typeof runScriptWithRunCredential = runScriptWithRunCredential,
): Promise<{ quiet: false; reason: string } | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout after 10000ms"));
      }, PROBE_TIMEOUT_MS);
    });
    const output = await Promise.race([
      runner({
        source: "export default async function () { return true; }",
        agentId,
        fsMode: "none",
        timeoutMs: PROBE_TIMEOUT_MS,
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (output.exitCode !== 0 || output.error || output.runtimeError) {
      throw new Error(
        output.runtimeError?.message ??
          output.error ??
          `script exited with code ${output.exitCode}`,
      );
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      quiet: false,
      reason: `script-runner-unhealthy: ${scrubSecrets(message)}`.slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}
