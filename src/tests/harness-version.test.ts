import { describe, expect, mock, test } from "bun:test";
import { readPkgVersion } from "../providers/harness-version";

describe("readPkgVersion", () => {
  test("reads pi version from the CLI before package.json probes", () => {
    const spawn = mock(() => ({ stdout: "0.79.1\n", stderr: "", status: 0 }));
    const requirePackageJson = mock(() => ({ version: "0.0.0" }));

    const version = readPkgVersion("@earendil-works/pi-coding-agent", {
      requirePackageJson,
      spawn,
    });

    expect(version).toBe("0.79.1");
    expect(spawn).toHaveBeenCalledWith("pi", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(requirePackageJson).not.toHaveBeenCalled();
  });

  test("reads opencode version from the CLI before package.json probes", () => {
    const spawn = mock(() => ({ stdout: "opencode 1.16.2\n", stderr: "", status: 0 }));
    const requirePackageJson = mock(() => ({ version: "0.0.0" }));

    const version = readPkgVersion("@opencode-ai/sdk", {
      requirePackageJson,
      spawn,
    });

    expect(version).toBe("1.16.2");
    expect(spawn).toHaveBeenCalledWith("opencode", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(requirePackageJson).not.toHaveBeenCalled();
  });

  test("falls back to package.json when no CLI mapping returns a version", () => {
    const version = readPkgVersion("@earendil-works/pi-coding-agent", {
      requirePackageJson: () => ({ version: "0.79.1" }),
      spawn: mock(() => ({ stdout: "", stderr: "", status: 0 })),
    });

    expect(version).toBe("0.79.1");
  });
});
