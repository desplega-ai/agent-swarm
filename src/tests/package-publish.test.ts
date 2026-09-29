import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const tempDir = await realpath(await mkdtemp(join(tmpdir(), "agent-swarm-pack-")));
const unpackDir = join(tempDir, "unpacked");
const cliPath = join(unpackDir, "package", "dist", "cli.js");
const nodePath = Bun.which("node")!;
const emptyPath = join(tempDir, "empty-path");

beforeAll(async () => {
  const tarballPath = join(tempDir, "agent-swarm.tgz");
  expectChildOk(
    await runChild(["bun", "pm", "pack", "--filename", tarballPath], { cwd: REPO_ROOT }),
    "pack CLI",
  );
  await mkdir(unpackDir);
  await mkdir(emptyPath);
  expectChildOk(await runChild(["tar", "-xzf", tarballPath, "-C", unpackDir]), "unpack CLI");
  // Reuse installed dependencies without a network install.
  await symlink(join(REPO_ROOT, "node_modules"), join(unpackDir, "package", "node_modules"));
}, CHILD_PROCESS_TEST_BUDGET_MS);

afterAll(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("published package", () => {
  test(
    "version and help work without Bun installed",
    async () => {
      for (const args of [["version"], ["onboard", "--help"], ["codex-login", "--help"]]) {
        const result = expectChildOk(
          await runChild([nodePath, cliPath, ...args], {
            cwd: unpackDir,
            env: { ...process.env, PATH: emptyPath },
          }),
          args.join(" "),
        );
        expect(result.stdout).toContain("agent-swarm");
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "onboard restarts with Bun and preserves arguments, environment, streams, and exit status",
    async () => {
      const binDir = join(tempDir, "fake-bin");
      await mkdir(binDir);
      const bunPath = join(binDir, "bun");
      await Bun.write(
        bunPath,
        `#!${process.execPath}
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.ONBOARD_TEST_MARKER, bun: !!process.versions.bun }));
console.error("test stderr");
process.exit(37);
`,
      );
      await chmod(bunPath, 0o755);
      const args = ["onboard", "--dry-run", "--preset", "value with spaces"];
      const result = await runChild([nodePath, cliPath, ...args], {
        cwd: unpackDir,
        env: { ...process.env, PATH: binDir, ONBOARD_TEST_MARKER: "preserved" },
      });
      expect(result.exitCode).toBe(37);
      expect(JSON.parse(result.stdout)).toEqual({
        args: [cliPath, ...args],
        cwd: unpackDir,
        marker: "preserved",
        bun: true,
      });
      expect(result.stderr).toContain("test stderr");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "onboard reports a Bun installation requirement when Bun is unavailable",
    async () => {
      const result = await runChild([nodePath, cliPath, "onboard"], {
        cwd: unpackDir,
        env: { ...process.env, PATH: emptyPath },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Onboarding requires Bun.");
      expect(result.stderr).toContain("https://bun.sh");
      expect(result.stdout + result.stderr).not.toContain("Bun is not defined");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "onboard completes a dry run under Node and Bun",
    async () => {
      for (const runtime of [nodePath, process.execPath]) {
        const result = expectChildOk(
          await runChild([runtime, cliPath, "onboard", "--yes", "--preset=solo", "--dry-run"], {
            cwd: unpackDir,
            env: {
              ...process.env,
              HARNESS_PROVIDER: "claude",
              ANTHROPIC_API_KEY: "test-onboard-key",
            },
          }),
          "onboard dry run",
        );
        expect(result.stdout).toContain("DRY-RUN MODE");
        expect(result.stdout + result.stderr).not.toContain("Bun is not defined");
      }
      expect(await Bun.file(join(unpackDir, "docker-compose.yml")).exists()).toBe(false);
      expect(await Bun.file(join(unpackDir, ".env")).exists()).toBe(false);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
