/* script-smoke
{
  "name": "scripts-smoke-import-bypass",
  "description": "Probe import allowlist and runtime globals that can reach filesystem/process APIs",
  "intent": "rich scripts api smoke import bypass",
  "args": {},
  "expect": {
    "exitCode": 0,
    "result": {
      "literalDynamicImportError": "import_violation",
      "functionImportError": "import_violation",
      "functionImportOk": false,
      "bunFileSourceReadable": true,
      "processEnvHasScriptTmpdir": true,
      "processEnvHasApiKey": false
    },
    "responseExcludes": ["__API_KEY__"]
  }
}
*/

export default async (_args: unknown, ctx: any) => {
  const literalDynamic = await ctx.swarm.script_run({
    source: "export default async () => import('node:fs');",
    intent: "literal dynamic import should be blocked",
    args: {},
  });

  const functionImport = await ctx.swarm.script_run({
    source: `export default async () => new Function("return import('node:fs')")();`,
    intent: "Function constructor dynamic import should be blocked",
    args: {},
  });

  const proc = (globalThis as any).process;
  const bun = (globalThis as any).Bun;
  const sourceFile = proc?.env?.SWARM_SCRIPT_SOURCE_FILE;
  const envKeys = Object.keys(proc?.env ?? {});

  return {
    literalDynamicImportError: literalDynamic?.data?.error,
    literalDynamicImportStderr: literalDynamic?.data?.stderr,
    functionImportOk: functionImport?.data?.exitCode === 0,
    functionImportError: functionImport?.data?.error,
    functionImportStderr: functionImport?.data?.stderr,
    bunFileSourceReadable: sourceFile ? await bun.file(sourceFile).exists() : false,
    processEnvHasScriptTmpdir: envKeys.includes("SWARM_SCRIPT_TMPDIR"),
    processEnvHasApiKey: envKeys.includes("API_KEY") || envKeys.includes("AGENT_SWARM_API_KEY"),
    processEnvKeys: envKeys.sort(),
  };
};
