import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("run-bun-tests.sh", () => {
  let fixtureDir: string | undefined;

  afterEach(async () => {
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
      fixtureDir = undefined;
    }
  });

  test("surfaces Bun between-test errors in the annotation and step summary", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-wrapper-"));
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

    const result = Bun.spawnSync(["bash", "scripts/run-bun-tests.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: stepSummary,
        RUNNER_TEMP: fixtureDir,
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

  test("does not print GitHub workflow commands in a local terminal", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-wrapper-"));
    const fakeBinDir = join(fixtureDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");

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

    const result = Bun.spawnSync(["bash", "scripts/run-bun-tests.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        GITHUB_ACTIONS: "",
        GITHUB_STEP_SUMMARY: "",
        RUNNER_TEMP: fixtureDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("# Unhandled error between tests");
    expect(result.stdout.toString()).not.toContain("::error");
  });

  test("preserves Bun's exit status", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-wrapper-"));
    const fakeBinDir = join(fixtureDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const stepSummary = join(fixtureDir, "step-summary.md");

    await mkdir(fakeBinDir);
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
echo " 1 fail"
exit 7
`,
    );
    await chmod(fakeBun, 0o755);

    const result = Bun.spawnSync(["bash", "scripts/run-bun-tests.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        GITHUB_STEP_SUMMARY: stepSummary,
        RUNNER_TEMP: fixtureDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(7);
    expect(await Bun.file(stepSummary).exists()).toBe(false);
  });

  test("forwards a single test file and options through the package script", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-wrapper-"));
    const fakeBinDir = join(fixtureDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const argsFile = join(fixtureDir, "args.txt");

    await mkdir(fakeBinDir);
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$BUN_ARGS_FILE"
exit 0
`,
    );
    await chmod(fakeBun, 0o755);

    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "test:root",
        "--",
        "src/tests/example.test.ts",
        "--timeout",
        "1234",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          BUN_ARGS_FILE: argsFile,
          RUNNER_TEMP: fixtureDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(await readFile(argsFile, "utf-8")).toBe(
      "test\nsrc/tests/example.test.ts\n--timeout\n1234\n",
    );
  });

  test("runs one Bun process when no shard is passed", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-wrapper-"));
    const fakeBinDir = join(fixtureDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const argsFile = join(fixtureDir, "args.txt");

    await mkdir(fakeBinDir);
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$BUN_ARGS_FILE"
exit 0
`,
    );
    await chmod(fakeBun, 0o755);

    const result = Bun.spawnSync(["bash", "scripts/run-bun-tests.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        BUN_ARGS_FILE: argsFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(argsFile, "utf-8")).toBe("test\n");
  });

  test("forwards an explicit CI shard without spawning sibling shards", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-wrapper-"));
    const fakeBinDir = join(fixtureDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const argsFile = join(fixtureDir, "args.txt");

    await mkdir(fakeBinDir);
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$BUN_ARGS_FILE"
exit 0
`,
    );
    await chmod(fakeBun, 0o755);

    const result = Bun.spawnSync(["bash", "scripts/run-bun-tests.sh", "--shard=2/4"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        BUN_ARGS_FILE: argsFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(await readFile(argsFile, "utf-8")).toBe("test\n--shard=2/4\n");
  });

  test("preserves a failing explicit shard's exit status", async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "bun-test-wrapper-"));
    const fakeBinDir = join(fixtureDir, "bin");
    const fakeBun = join(fakeBinDir, "bun");
    const argsFile = join(fixtureDir, "args.txt");

    await mkdir(fakeBinDir);
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$BUN_ARGS_FILE"
echo " 1 fail"
exit 7
`,
    );
    await chmod(fakeBun, 0o755);

    const result = Bun.spawnSync(["bash", "scripts/run-bun-tests.sh", "--shard=3/4"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        BUN_ARGS_FILE: argsFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(7);
    expect(await readFile(argsFile, "utf-8")).toBe("test\n--shard=3/4\n");
  });
});
