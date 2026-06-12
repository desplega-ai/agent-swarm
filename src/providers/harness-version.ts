import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

declare const __AGENT_SWARM_PI_CODING_AGENT_VERSION__: string | undefined;
declare const __AGENT_SWARM_OPENCODE_SDK_VERSION__: string | undefined;

type PackageJson = { version?: unknown };

type ReadPkgVersionOptions = {
  requirePackageJson?: (specifier: string) => PackageJson;
  readFile?: (path: string, encoding: BufferEncoding) => string;
  spawn?: typeof spawnSync;
  globalNodeModulesRoots?: string[];
};

const embeddedHarnessVersions: Record<string, string | undefined> = {
  "@earendil-works/pi-coding-agent":
    typeof __AGENT_SWARM_PI_CODING_AGENT_VERSION__ === "undefined"
      ? undefined
      : __AGENT_SWARM_PI_CODING_AGENT_VERSION__,
  "@opencode-ai/sdk":
    typeof __AGENT_SWARM_OPENCODE_SDK_VERSION__ === "undefined"
      ? undefined
      : __AGENT_SWARM_OPENCODE_SDK_VERSION__,
};

const cliVersionCommands: Record<string, { command: string; args: string[] }> = {
  "@earendil-works/pi-coding-agent": { command: "pi", args: ["--version"] },
  "@opencode-ai/sdk": { command: "opencode", args: ["--version"] },
};

function normalizeVersion(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readPackageJsonVersion(raw: string): string | undefined {
  try {
    return normalizeVersion(JSON.parse(raw).version);
  } catch {
    return undefined;
  }
}

function parseCliVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

export function readPkgVersion(
  packageName: string,
  {
    requirePackageJson = (specifier) => require(specifier) as PackageJson,
    readFile = readFileSync,
    spawn = spawnSync,
    globalNodeModulesRoots = ["/usr/lib/node_modules", "/usr/local/lib/node_modules"],
  }: ReadPkgVersionOptions = {},
): string | undefined {
  const embeddedVersion = embeddedHarnessVersions[packageName];
  if (embeddedVersion) return embeddedVersion;

  try {
    const version = normalizeVersion(requirePackageJson(`${packageName}/package.json`).version);
    if (version) return version;
  } catch {
    // Bun-compiled binaries cannot resolve packages that only exist in the
    // container's global node_modules. Fall through to filesystem and CLI probes.
  }

  for (const root of globalNodeModulesRoots) {
    try {
      const version = readPackageJsonVersion(
        readFile(join(root, packageName, "package.json"), "utf8"),
      );
      if (version) return version;
    } catch {
      // Try the next global install location.
    }
  }

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
