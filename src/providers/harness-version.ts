import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

type PackageJson = { name?: unknown; version?: unknown };

type ReadPkgVersionOptions = {
  requirePackageJson?: (specifier: string) => PackageJson;
  spawn?: typeof spawnSync;
  /** Version of the package that owns `command` on PATH, or undefined. No process is spawned. */
  readInstalledVersion?: (command: string, packageName: string) => string | undefined;
};

const cliVersionCommands: Record<string, { command: string; args: string[] }> = {
  "@earendil-works/pi-coding-agent": { command: "pi", args: ["--version"] },
  "@opencode-ai/sdk": { command: "opencode", args: ["--version"] },
};

// The CLI does not change under a running process, so spawn it at most once.
const spawnedCliVersions = new Map<string, string | undefined>();

function normalizeVersion(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseCliVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Reads the version of the npm package a CLI shim belongs to by walking up from the shim's real
 * path to the package.json that names `packageName`. `pi --version` prints exactly that file's
 * `version`, so this gives the same answer without starting a process.
 */
export function readInstalledCliPackageVersion(
  command: string,
  packageName: string,
): string | undefined {
  const binPath = findOnPath(command);
  if (!binPath) return undefined;

  let dir: string;
  try {
    dir = dirname(realpathSync(binPath));
  } catch {
    return undefined;
  }

  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
      if (pkg.name === packageName) return normalizeVersion(pkg.version);
    } catch {
      // No package.json at this level, or not valid JSON: keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function spawnCliVersion(
  packageName: string,
  command: { command: string; args: string[] },
  spawn: typeof spawnSync,
): string | undefined {
  // Only the real spawnSync is cached; an injected one (tests) must run every call.
  const cacheable = spawn === spawnSync;
  if (cacheable && spawnedCliVersions.has(packageName)) return spawnedCliVersions.get(packageName);

  let version: string | undefined;
  try {
    const result = spawn(command.command, command.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    version = parseCliVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  } catch {
    version = undefined;
  }
  if (cacheable) spawnedCliVersions.set(packageName, version);
  return version;
}

function readCliVersion(
  packageName: string,
  spawn: typeof spawnSync,
  readInstalledVersion: NonNullable<ReadPkgVersionOptions["readInstalledVersion"]>,
): string | undefined {
  const command = cliVersionCommands[packageName];
  if (!command) return undefined;

  // Prefer reading the installed package: a synchronous spawn blocks this thread for the whole
  // child run, and on Bun 1.4.0 a `pi --version` spawnSync intermittently never returns (the child
  // exits and stays a zombie while the parent spins), which wedged CI test workers for 20 minutes.
  const installed = readInstalledVersion(command.command, packageName);
  if (installed) return installed;

  return spawnCliVersion(packageName, command, spawn);
}

export function readPkgVersion(
  packageName: string,
  {
    requirePackageJson = (specifier) => require(specifier) as PackageJson,
    spawn = spawnSync,
    readInstalledVersion = readInstalledCliPackageVersion,
  }: ReadPkgVersionOptions = {},
): string | undefined {
  const cliVersion = readCliVersion(packageName, spawn, readInstalledVersion);
  if (cliVersion) return cliVersion;

  try {
    const version = normalizeVersion(requirePackageJson(`${packageName}/package.json`).version);
    if (version) return version;
  } catch {
    return undefined;
  }
}
