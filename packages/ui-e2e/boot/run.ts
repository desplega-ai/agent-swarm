import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(packageRoot, "../..");

// Spawn the installed bin directly: a bare `npx playwright` would download an
// unrelated package when the workspace install is missing.
async function findPlaywrightBin(): Promise<string> {
  for (const root of [packageRoot, repoRoot]) {
    const candidate = resolve(root, "node_modules/.bin/playwright");
    if (await Bun.file(candidate).exists()) return candidate;
  }
  throw new Error(`Playwright binary not found under ${packageRoot} or ${repoRoot}`);
}

async function run(command: string[], cwd: string, env = process.env): Promise<number> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

async function main(): Promise<void> {
  let noBuild = false;
  const passthrough: string[] = [];
  for (const argument of Bun.argv.slice(2)) {
    if (argument === "--") continue;
    if (argument === "--no-build") {
      noBuild = true;
      continue;
    }
    passthrough.push(argument);
  }

  if (!noBuild && !process.env.E2E_UI_URL) {
    const buildExit = await run(["bun", "run", "build"], resolve(repoRoot, "apps/ui"), {
      ...process.env,
      VITE_API_URL: "",
      VITE_API_KEY: "",
      VITE_DEMO_MODE: "",
    });
    if (buildExit !== 0) process.exit(buildExit);
  }

  const playwrightExit = await run(
    [await findPlaywrightBin(), "test", ...passthrough],
    packageRoot,
  );
  process.exit(playwrightExit);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
