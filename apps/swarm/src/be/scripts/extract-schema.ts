/**
 * Server-side helper: spawns a subprocess to extract the argsJsonSchema
 * from a user script's `argsSchema` Zod export. Returns the JSON Schema
 * serialized as a string, or null if the script has no argsSchema or
 * if extraction fails.
 *
 * Extraction is best-effort and non-blocking — failures return null.
 */

const TIMEOUT_MS = 5_000;

function extractorPath(): string {
  return new URL("../../scripts-runtime/extract-args-schema.ts", import.meta.url).pathname;
}

export async function extractArgsJsonSchema(source: string): Promise<string | null> {
  const tmpdir = `${process.env.TMPDIR ?? "/tmp"}/schema-extract-${crypto.randomUUID()}`;

  try {
    await Bun.$`mkdir -p ${tmpdir}`.quiet();

    const sourceFile = `${tmpdir}/source.ts`;
    const resultFile = `${tmpdir}/result.json`;
    await Bun.write(sourceFile, source);

    const proc = Bun.spawn(["bun", "run", extractorPath()], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        TMPDIR: tmpdir,
        SWARM_SCHEMA_SOURCE_FILE: sourceFile,
        SWARM_SCHEMA_RESULT_FILE: resultFile,
        SWARM_SCHEMA_TMPDIR: tmpdir,
      },
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
