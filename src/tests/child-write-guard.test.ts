/**
 * Every process the suite spawns inherits the profile write guard, without the
 * test that spawns it asking for it (agent-swarm-ops#884). The real paths
 * (`/workspace`, `/tmp/identity-baselines.json`) are never touched here: the
 * child gets a simulated workspace and baselines file inside a tmpdir.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WRITE_GUARD_PATHS_ENV } from "./fixtures/child-write-guard";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

const probe = join(import.meta.dir, "fixtures", "child-write-guard-probe.ts");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function simulatedWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "child-write-guard-"));
  roots.push(root);
  const paths = {
    workspace: join(root, "workspace"),
    baselines: join(root, "identity-baselines.json"),
  };
  await Bun.write(join(paths.workspace, "SOUL.md"), "simulated soul intact");
  await Bun.write(paths.baselines, "simulated baselines intact");
  return paths;
}

async function expectIntact(paths: { workspace: string; baselines: string }) {
  expect(await Bun.file(join(paths.workspace, "SOUL.md")).text()).toBe("simulated soul intact");
  expect(await Bun.file(paths.baselines).text()).toBe("simulated baselines intact");
}

/** Spawned like api-drain-worker-e2e: an explicit env that does not carry the parent's. */
function spawnProbe(target: string, operation: string, paths: object) {
  return runChild([process.execPath, probe, target, operation], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", [WRITE_GUARD_PATHS_ENV]: JSON.stringify(paths) },
  });
}

test(
  "a real child with an explicit env cannot Bun.write the simulated workspace",
  async () => {
    const paths = await simulatedWorkspace();
    const target = join(paths.workspace, "SOUL.md");
    const child = await spawnProbe(target, "bun-write", paths);
    console.log(child.stderr.trim());
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain(`PROFILE WRITE GUARD: escritura fuera del sandbox: ${target}`);
    expect(child.stdout).not.toContain("wrote");
    await expectIntact(paths);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "a real child cannot write the simulated baselines through an ESM named import",
  async () => {
    const paths = await simulatedWorkspace();
    const child = await spawnProbe(paths.baselines, "named-writeFile", paths);
    console.log(child.stderr.trim().split("\n")[0]);
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain(
      `PROFILE WRITE GUARD: escritura fuera del sandbox: ${paths.baselines}`,
    );
    await expectIntact(paths);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "a grandchild spawned with its own explicit env inherits the guard",
  async () => {
    const paths = await simulatedWorkspace();
    const target = join(paths.workspace, "SOUL.md");
    const child = await spawnProbe(target, "grandchild", paths);
    console.log(child.stderr.trim().split("\n")[0]);
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr).toContain(`PROFILE WRITE GUARD: escritura fuera del sandbox: ${target}`);
    await expectIntact(paths);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
