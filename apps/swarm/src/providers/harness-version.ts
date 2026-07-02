import { spawnSync } from "node:child_process";

type PackageJson = { version?: unknown };

type ReadPkgVersionOptions = {
  requirePackageJson?: (specifier: string) => PackageJson;
  spawn?: typeof spawnSync;
};

const cliVersionCommands: Record<string, { command: string; args: string[] }> = {
  "@earendil-works/pi-coding-agent": { command: "pi", args: ["--version"] },
  "@opencode-ai/sdk": { command: "opencode", args: ["--version"] },
};

function normalizeVersion(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseCliVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

function readCliVersion(packageName: string, spawn: typeof spawnSync): string | undefined {
  const command = cliVersionCommands[packageName];
  if (!command) return undefined;

  try {
    const result = spawn(command.command, command.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseCliVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  } catch {
    return undefined;
  }
}

export function readPkgVersion(
  packageName: string,
  {
    requirePackageJson = (specifier) => require(specifier) as PackageJson,
    spawn = spawnSync,
  }: ReadPkgVersionOptions = {},
): string | undefined {
  const cliVersion = readCliVersion(packageName, spawn);
  if (cliVersion) return cliVersion;

  try {
    const version = normalizeVersion(requirePackageJson(`${packageName}/package.json`).version);
    if (version) return version;
  } catch {
    return undefined;
  }
}
