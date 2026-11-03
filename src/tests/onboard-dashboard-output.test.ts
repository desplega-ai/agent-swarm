import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const CLI = resolve(import.meta.dir, "../cli.tsx");
const API_KEY = "onboard-fixture-with-+/=&-characters";
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onboard-dashboard-output-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function onboard(installer: boolean) {
  const result = expectChildOk(
    await runChild([process.execPath, CLI, "onboard", "--yes", "--preset", "solo", "--dry-run"], {
      cwd: dir,
      env: {
        ...process.env,
        AGENT_SWARM_API_KEY: API_KEY,
        AGENT_SWARM_INSTALLER: installer ? "1" : "0",
        DESPLEGA_TELEMETRY_ENV: "test",
        NO_COLOR: "1",
      },
    }),
    "onboard dry-run",
  );
  return result.stdout + result.stderr;
}

describe("onboard dashboard output", () => {
  test(
    "standalone --yes keeps a redacted dashboard link and writes no files in dry-run",
    async () => {
      const out = await onboard(false);
      // Ink wraps links at the terminal width; also check across line boundaries.
      const compact = out.replace(/\s/g, "");
      expect(compact).not.toContain(API_KEY);
      expect(compact).not.toContain(new URLSearchParams({ apiKey: API_KEY }).toString());
      expect(out).toContain("Dashboard:");
      expect(out).toContain("REDACTED");
      expect(await Bun.file(join(dir, ".agent-swarm/setup-url")).exists()).toBe(false);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "installer mode leaves the dashboard link to install.sh",
    async () => {
      const out = await onboard(true);
      expect(out).toContain("Your swarm is running!");
      expect(out).not.toContain("Dashboard:");
      expect(out).not.toContain("app.agent-swarm.dev");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test.each([0, 1])(
    "browser open (exit %s) uses the full key while the prompt and fallback stay redacted",
    async (exitCode) => {
      const argsPath = join(dir, "open-args");
      const open = join(dir, "open");
      await Bun.write(open, `#!/bin/sh\nprintf '%s' "$1" > "$OPEN_ARGS"\nexit ${exitCode}\n`);
      await chmod(open, 0o755);
      const fixture = join(dir, "post-dashboard.ts");
      await Bun.write(
        fixture,
        `import { PostDashboardStep } from ${JSON.stringify(resolve(import.meta.dir, "../commands/onboard/steps/post-dashboard.tsx"))};
import { INITIAL_STATE } from ${JSON.stringify(resolve(import.meta.dir, "../commands/onboard/types.ts"))};
const logs = [];
let advanced = false;
const view = PostDashboardStep({
  state: { ...INITIAL_STATE, apiKey: ${JSON.stringify(API_KEY)} },
  dryRun: false,
  addLog: (line) => logs.push(line),
  goToNext: () => { advanced = true; },
  goToStep: () => {},
  goToError: () => {},
});
const children = view.props.children;
await children.at(-1).props.children.props.onChange("yes");
console.log(JSON.stringify({ display: children[1].props.children, logs, advanced }));
`,
      );
      const result = expectChildOk(
        await runChild([process.execPath, fixture], {
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, OPEN_ARGS: argsPath },
        }),
        "post-dashboard browser action",
      );
      const out = result.stdout + result.stderr;
      expect(out).not.toContain(API_KEY);
      expect(out).not.toContain(encodeURIComponent(API_KEY));
      const data = JSON.parse(result.stdout);
      expect(data.display).toContain("REDACTED");
      expect(data.advanced).toBe(true);
      expect(new URL(await Bun.file(argsPath).text()).searchParams.get("apiKey")).toBe(API_KEY);
      expect(data.logs.join("\n")).toContain(
        exitCode === 0 ? "Opened dashboard" : "cat .agent-swarm/setup-url",
      );
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
