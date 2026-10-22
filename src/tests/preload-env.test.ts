import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

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
      "APP_URL",
      "AGENT_FS_API_URL",
      "AGENT_FS_LIVE_URL",
      "AGENT_FS_DEFAULT_ORG_ID",
      "AGENT_FS_DEFAULT_DRIVE_ID",
      "SWARM_ORG_NAME",
      "SWARM_ORG_WEBSITE",
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
