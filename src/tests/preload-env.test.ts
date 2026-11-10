import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHILD_PROCESS_TEST_BUDGET_MS,
  CHILD_PROCESS_TIMEOUT_MS,
  expectChildOk,
  runChild,
} from "./test-proc";

test(
  "preload clears inherited worker configuration before test files load",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarm-preload-env-"));
    const fixture = join(directory, "worker-env.test.ts");
    const keys = [
      "SLACK_RENDER_V2",
      "SLACK_STATUS_ICON_COMPLETED",
      "SLACK_FUTURE_SETTING",
      "COMB_ENABLED",
      "SYSTEM_ONE_DEFAULT_PROVIDER",
      "SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER",
      "APP_URL",
      "AGENT_FS_API_URL",
      "AGENT_FS_PROXY",
      "AGENT_FS_LIVE_URL",
      "AGENT_FS_LINK_TARGET",
      "AGENT_FS_DEFAULT_ORG_ID",
      "AGENT_FS_DEFAULT_DRIVE_ID",
      "SWARM_ORG_NAME",
      "SWARM_ORG_WEBSITE",
      "EMBEDDING_QUERY_PREFIX",
      "EMBEDDING_DOCUMENT_PREFIX",
    ];
    try {
      await Bun.write(
        fixture,
        `import { expect, test } from "bun:test";
const inherited = ${JSON.stringify(keys)}.filter(key => process.env[key] !== undefined);
test("worker defaults are cleared before module evaluation", () => {
  expect(inherited).toEqual([]);
  expect(process.env.PRELOAD_ENV_CONTROL).toBe("preserved");
  process.env.SLACK_STATUS_ICON_COMPLETED = "test-icon";
});
test("suite configuration survives between tests", () => {
  expect(process.env.SLACK_STATUS_ICON_COMPLETED).toBe("test-icon");
});
`,
      );
      const result = expectChildOk(
        await runChild([process.execPath, "test", fixture], {
          cwd: join(import.meta.dir, "../.."),
          env: {
            ...process.env,
            ...Object.fromEntries(keys.map((key) => [key, "inherited-worker-setting"])),
            PRELOAD_ENV_CONTROL: "preserved",
          },
        }),
        "test runner with inherited worker env",
      );
      expect(result.stderr).toContain("2 pass");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  "a Bun child spawned by a test file dies when its test run is SIGKILLed",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "swarm-preload-orphan-"));
    const fixture = join(directory, "spawns-child.test.ts");
    const pidFile = join(directory, "child.pid");
    // Same shape as the suites that boot `bun src/http.ts`: inherited env, stopped in afterAll.
    await Bun.write(
      fixture,
      `import { test } from "bun:test";
test("holds a child open", async () => {
  const child = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], { env: { ...process.env } });
  await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
  await new Promise(() => {});
}, 60_000);
`,
    );
    // The run starts without the flag, as the pre-push hook and CI start it.
    const { BUN_FEATURE_FLAG_NO_ORPHANS: _flag, ...env } = process.env;
    const run = Bun.spawn([process.execPath, "test", fixture], {
      cwd: join(import.meta.dir, "../.."),
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    let childPid = 0;
    try {
      const deadline = Date.now() + CHILD_PROCESS_TIMEOUT_MS;
      while (Date.now() < deadline && !(await Bun.file(pidFile).exists())) await Bun.sleep(50);
      childPid = Number(await Bun.file(pidFile).text());
      expect(isAlive(childPid)).toBe(true);

      run.kill("SIGKILL");
      await run.exited;
      const gone = Date.now() + 10_000;
      while (Date.now() < gone && isAlive(childPid)) await Bun.sleep(50);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      run.kill("SIGKILL");
      if (childPid && isAlive(childPid)) process.kill(childPid, "SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS + 10_000,
);
