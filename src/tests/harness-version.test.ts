import { describe, expect, mock, test } from "bun:test";
import { readPkgVersion } from "../providers/harness-version";

describe("readPkgVersion", () => {
  test("falls back to global node_modules when bundled require cannot resolve package.json", () => {
    const version = readPkgVersion("@earendil-works/pi-coding-agent", {
      requirePackageJson: () => {
        throw new Error("Cannot find module");
      },
      readFile: (path) => {
        expect(path).toBe("/usr/lib/node_modules/@earendil-works/pi-coding-agent/package.json");
        return JSON.stringify({ version: "0.79.1" });
      },
      spawn: mock(() => ({ stdout: "", stderr: "", status: 0 })),
      globalNodeModulesRoots: ["/usr/lib/node_modules"],
    });

    expect(version).toBe("0.79.1");
  });

  test("falls back to CLI version output when package.json probes fail", () => {
    const spawn = mock(() => ({ stdout: "pi 0.79.1\n", stderr: "", status: 0 }));

    const version = readPkgVersion("@earendil-works/pi-coding-agent", {
      requirePackageJson: () => {
        throw new Error("Cannot find module");
      },
      readFile: () => {
        throw new Error("ENOENT");
      },
      spawn,
      globalNodeModulesRoots: ["/usr/lib/node_modules"],
    });

    expect(version).toBe("0.79.1");
    expect(spawn).toHaveBeenCalledWith("pi", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});
