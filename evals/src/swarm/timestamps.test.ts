import { describe, expect, test } from "bun:test";
import { withLineTimestamps } from "./sandbox.ts";

/** Frozen line shape (v6 §4): `<ISO-8601 UTC, second precision>Z <original line>`. */
const TS_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z .+$/;

/**
 * Runs the generated wrapper under the same conditions as the sandbox
 * (`bash -c` + `set -o pipefail`, mirroring buildTrackedShell). Requires
 * bash >= 4.2 (printf %T) and coreutils stdbuf — both ship in the sandbox
 * images; locally they come from homebrew/system coreutils.
 */
async function runWrapped(cmd: string): Promise<{ exitCode: number; lines: string[] }> {
  const proc = Bun.spawn(["bash", "-c", `set -o pipefail; ${withLineTimestamps(cmd)}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  return { exitCode, lines };
}

describe("withLineTimestamps (v6 §4)", () => {
  test("every output line carries the frozen ISO-8601 UTC prefix", async () => {
    const { exitCode, lines } = await runWrapped("printf 'alpha\\nbeta\\n'");
    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(TS_LINE_RE);
    expect(lines[0]?.endsWith(" alpha")).toBe(true);
    expect(lines[1]?.endsWith(" beta")).toBe(true);
  });

  test("a trailing unterminated line is flushed at EOF", async () => {
    const { exitCode, lines } = await runWrapped("printf 'a\\nb'"); // no trailing newline
    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(TS_LINE_RE);
    expect(lines[1]?.endsWith(" b")).toBe(true);
  });

  test("stderr is merged into the timestamped stream", async () => {
    const { lines } = await runWrapped("sh -c 'echo to-stderr 1>&2'");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TS_LINE_RE);
    expect(lines[0]?.endsWith(" to-stderr")).toBe(true);
  });

  test("a non-zero inner command propagates a non-zero exit under pipefail", async () => {
    const { exitCode } = await runWrapped("sh -c 'echo dying; exit 7'");
    expect(exitCode).not.toBe(0);
  });
});
