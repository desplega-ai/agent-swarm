/**
 * Subprocess script: extracts the argsJsonSchema from a user script module.
 * Spawned by src/be/scripts/extract-schema.ts during script_upsert.
 *
 * Env vars (all required):
 *   SWARM_SCHEMA_SOURCE_FILE  path to the script source file
 *   SWARM_SCHEMA_RESULT_FILE  path where JSON Schema (or "null") is written
 *   SWARM_SCHEMA_TMPDIR       tmpdir used for shims + the user module
 */
import { toJSONSchema } from "zod";

async function createShims(tmpdir: string): Promise<void> {
  const zodEntry = Bun.resolveSync("zod", import.meta.dir);
  const shims: [string, URL][] = [
    ["stdlib", new URL("./stdlib/index.ts", import.meta.url)],
    ["swarm-sdk", new URL("./swarm-sdk.ts", import.meta.url)],
    ["zod", new URL(`file://${zodEntry}`)],
  ];
  for (const [name, url] of shims) {
    const dir = `${tmpdir}/node_modules/${name}`;
    await Bun.$`mkdir -p ${dir}`.quiet();
    await Bun.write(`${dir}/package.json`, JSON.stringify({ type: "module", main: "index.ts" }));
    await Bun.write(`${dir}/index.ts`, `export * from ${JSON.stringify(url.href)};\n`);
  }
}

const sourceFile = process.env.SWARM_SCHEMA_SOURCE_FILE;
const resultFile = process.env.SWARM_SCHEMA_RESULT_FILE;
const tmpdir = process.env.SWARM_SCHEMA_TMPDIR;

if (!sourceFile || !resultFile || !tmpdir) {
  process.stderr.write("extract-args-schema: missing required env vars\n");
  process.exit(1);
}

try {
  await createShims(tmpdir);

  const source = await Bun.file(sourceFile).text();
  const userModulePath = `${tmpdir}/user-script.ts`;
  await Bun.write(userModulePath, source);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(userModulePath)) as Record<string, unknown>;
  } catch {
    // Import failed (e.g. unresolvable imports) — not an error, just no schema
    await Bun.write(resultFile, "null");
    process.exit(0);
  }

  if (!mod.argsSchema || typeof mod.argsSchema !== "object") {
    await Bun.write(resultFile, "null");
    process.exit(0);
  }

  // biome-ignore lint/suspicious/noExplicitAny: argsSchema is a Zod schema at runtime
  const schema = toJSONSchema(mod.argsSchema as any);
  await Bun.write(resultFile, JSON.stringify(schema));
  process.exit(0);
} catch (err) {
  process.stderr.write(
    `extract-args-schema: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  try {
    await Bun.write(resultFile, "null");
  } catch {}
  process.exit(0);
}
