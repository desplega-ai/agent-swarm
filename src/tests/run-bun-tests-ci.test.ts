import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("run-bun-tests-ci.sh", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
      fixtureDir = undefined;
    }
  });

  test("surfaces Bun between-test errors in the annotation and step summary", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-ci-wrapper-"));
    const fakeBinDir = join(fixtureDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const stepSummary = join(fixtureDir, "step-summary.md");

    await mkdir(fakeBinDir);
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
echo "# Unhandled error between tests"
echo "TypeError: escaped attempt marker"
echo
echo " 10 pass"
echo " 0 fail"
echo " 1 error"
exit 1
`,
    );
    await chmod(fakeBun, 0o755);

    const result = Bun.spawnSync(["bash", "scripts/run-bun-tests-ci.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        GITHUB_STEP_SUMMARY: stepSummary,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain(
      "::error title=Bun unhandled test error::Bun reported 1 unhandled error(s)",
    );
    const summary = await readFile(stepSummary, "utf-8");
    expect(summary).toContain("### Bun test runner failure");
    expect(summary).toContain("TypeError: escaped attempt marker");
    expect(summary).toContain("0 fail");
    expect(summary).toContain("1 error");
  });

  test("preserves a successful Bun exit without writing a failure summary", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-ci-wrapper-"));
    const fakeBinDir = join(fixtureDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const stepSummary = join(fixtureDir, "step-summary.md");

    await mkdir(fakeBinDir);
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
echo " 10 pass"
echo " 0 fail"
exit 0
`,
    );
    await chmod(fakeBun, 0o755);

    const result = Bun.spawnSync(["bash", "scripts/run-bun-tests-ci.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        GITHUB_STEP_SUMMARY: stepSummary,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(stepSummary).exists()).toBe(false);
  });
});
