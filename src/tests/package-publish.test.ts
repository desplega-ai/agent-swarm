import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const tempDir = mkdtempSync(join(tmpdir(), "agent-swarm-pack-"));

setDefaultTimeout(30_000);

afterAll(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

describe("published package", () => {
  test("version command works from an unpacked tarball", () => {
    const tarballPath = join(tempDir, "agent-swarm.tgz");
    const unpackDir = join(tempDir, "unpacked");

    execSync(`bun pm pack --filename ${JSON.stringify(tarballPath)}`, {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    execSync(
      `mkdir -p ${JSON.stringify(unpackDir)} && tar -xzf ${JSON.stringify(tarballPath)} -C ${JSON.stringify(unpackDir)}`,
      {
        cwd: REPO_ROOT,
        stdio: "pipe",
      },
    );

    const output = execSync(`bun ./package/src/cli.tsx version`, {
      cwd: unpackDir,
      encoding: "utf-8",
      stdio: "pipe",
    });

    expect(output).toContain("agent-swarm v");
  });
});
