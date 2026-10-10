import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledCliPackageVersion, readPkgVersion } from "../providers/harness-version";

describe("readPkgVersion", () => {
  test("reads the pi version from the installed package without spawning", () => {
    const spawn = mock(() => ({ stdout: "9.9.9\n", stderr: "", status: 0 }));
    const requirePackageJson = mock(() => ({ version: "0.0.0" }));
    const readInstalledVersion = mock(() => "0.79.1");

    const version = readPkgVersion("@earendil-works/pi-coding-agent", {
      requirePackageJson,
      spawn,
      readInstalledVersion,
    });

    expect(version).toBe("0.79.1");
    expect(readInstalledVersion).toHaveBeenCalledWith("pi", "@earendil-works/pi-coding-agent");
    expect(spawn).not.toHaveBeenCalled();
    expect(requirePackageJson).not.toHaveBeenCalled();
  });

  test("reads pi version from the CLI when the installed package cannot be found", () => {
    const spawn = mock(() => ({ stdout: "0.79.1\n", stderr: "", status: 0 }));
    const requirePackageJson = mock(() => ({ version: "0.0.0" }));

    const version = readPkgVersion("@earendil-works/pi-coding-agent", {
      requirePackageJson,
      spawn,
      readInstalledVersion: () => undefined,
    });

    expect(version).toBe("0.79.1");
    expect(spawn).toHaveBeenCalledWith("pi", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    expect(requirePackageJson).not.toHaveBeenCalled();
  });

  test("reads opencode version from the CLI before package.json probes", () => {
    const spawn = mock(() => ({ stdout: "opencode 1.16.2\n", stderr: "", status: 0 }));
    const requirePackageJson = mock(() => ({ version: "0.0.0" }));

    const version = readPkgVersion("@opencode-ai/sdk", {
      requirePackageJson,
      spawn,
      readInstalledVersion: () => undefined,
    });

    expect(version).toBe("1.16.2");
    expect(spawn).toHaveBeenCalledWith("opencode", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    expect(requirePackageJson).not.toHaveBeenCalled();
  });

  test("falls back to package.json when no CLI mapping returns a version", () => {
    const version = readPkgVersion("@earendil-works/pi-coding-agent", {
      requirePackageJson: () => ({ version: "0.79.1" }),
      spawn: mock(() => ({ stdout: "", stderr: "", status: 0 })),
      readInstalledVersion: () => undefined,
    });

    expect(version).toBe("0.79.1");
  });
});

describe("readInstalledCliPackageVersion", () => {
  const originalPath = process.env.PATH;
  const tmpRoots: string[] = [];

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A global-install layout: `<root>/bin/fake-cli` -> `<root>/lib/node_modules/@acme/fake/dist/bundle/cli.js`. */
  function installFakeCli(packageName: string, version: string): string {
    const root = mkdtempSync(join(tmpdir(), "harness-version-"));
    tmpRoots.push(root);
    const pkgDir = join(root, "lib", "node_modules", "@acme", "fake");
    mkdirSync(join(pkgDir, "dist", "bundle"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: packageName, version }));
    // A nested package.json without a matching name must be walked past.
    writeFileSync(join(pkgDir, "dist", "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(pkgDir, "dist", "bundle", "cli.js"), "#!/usr/bin/env node\n");
    symlinkSync(join(pkgDir, "dist", "bundle", "cli.js"), join(root, "bin", "fake-cli"));
    return join(root, "bin");
  }

  test("resolves the owning package version through the PATH symlink", () => {
    process.env.PATH = installFakeCli("@acme/fake", "1.2.3");
    expect(readInstalledCliPackageVersion("fake-cli", "@acme/fake")).toBe("1.2.3");
  });

  test("returns undefined when the owning package is a different one", () => {
    process.env.PATH = installFakeCli("@acme/other", "1.2.3");
    expect(readInstalledCliPackageVersion("fake-cli", "@acme/fake")).toBeUndefined();
  });

  test("returns undefined when the command is not on PATH", () => {
    process.env.PATH = installFakeCli("@acme/fake", "1.2.3");
    expect(readInstalledCliPackageVersion("not-installed-cli", "@acme/fake")).toBeUndefined();
  });
});
