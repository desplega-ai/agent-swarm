/**
 * Server-side helper: spawns a subprocess to extract the argsJsonSchema
 * from a user script's `argsSchema` Zod export. Returns the JSON Schema
 * serialized as a string, or null if the script has no argsSchema or
 * if extraction fails.
 *
 * Extraction is best-effort and non-blocking — failures return null.
 */

import { fileURLToPath } from "node:url";
import { buildSandboxedCommand } from "../../utils/sandboxed-process";

const TIMEOUT_MS = 5_000;

function extractorPath(): string {
  if (process.env.SCRIPT_RUNTIME_DIR) {
    return `${process.env.SCRIPT_RUNTIME_DIR}/extract-args-schema.bundle.js`;
  }
  return fileURLToPath(new URL("../../scripts-runtime/extract-args-schema.ts", import.meta.url));
}

export async function extractArgsJsonSchema(source: string): Promise<string | null> {
  const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/schema-extract-${crypto.randomUUID()}`;

  try {
    await Bun.$`mkdir -p ${tmpdir}`.quiet();

    const sourceFile = `${tmpdir}/source.ts`;
    const resultFile = `${tmpdir}/result.json`;
    await Bun.write(sourceFile, source);

    // The extractor imports user-supplied source. Run it under the same ulimit
    // sandbox and --no-orphans wrapper as a script run, so a hostile argsSchema
    // module gets the memory, CPU, process and file caps of the runtime.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: tmpdir,
      SWARM_SCHEMA_SOURCE_FILE: sourceFile,
      SWARM_SCHEMA_RESULT_FILE: resultFile,
      SWARM_SCHEMA_TMPDIR: tmpdir,
    };
    if (process.env.SCRIPT_RUNTIME_DIR) env.SCRIPT_RUNTIME_DIR = process.env.SCRIPT_RUNTIME_DIR;
    const proc = Bun.spawn(buildSandboxedCommand(["bun", "run", extractorPath()], env), {
      env,
      cwd: tmpdir,
      stdout: "ignore",
      stderr: "ignore",
    });

    const timeout = setTimeout(() => proc.kill(), TIMEOUT_MS);
    const exitCode = await proc.exited.catch(() => 1);
    clearTimeout(timeout);

    if (exitCode !== 0) return null;

    const result = await Bun.file(resultFile).text();
    const parsed: unknown = JSON.parse(result);
    if (parsed === null) return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  } finally {
    await Bun.$`rm -rf ${tmpdir}`.quiet().nothrow();
  }
}
