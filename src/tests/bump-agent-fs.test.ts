import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_FS_ADAPTER_NPM_PACKAGE } from "../../scripts/agent-fs-version-utils.ts";
import { applyPins, assertLockfilePinned, PINS } from "../../scripts/bump-agent-fs.ts";

const repo = new URL("../../", import.meta.url);

describe("bump-agent-fs", () => {
  test("rewrites the agent-fs-just-bash adapter pin in package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "bump-agent-fs-adapter-"));
    try {
      // Copy package.json even if PINS drops it, so the failure is the stale version.
      for (const path of new Set(["package.json", ...PINS.map((pin) => pin.path)])) {
        await Bun.write(join(root, path), Bun.file(new URL(path, repo)));
      }
      await applyPins("9.9.9", root);
      const manifest = await Bun.file(join(root, "package.json")).json();
      expect(manifest.dependencies[AGENT_FS_ADAPTER_NPM_PACKAGE]).toBe("9.9.9");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lockfile check accepts the target and rejects a stale adapter entry", async () => {
    const lock = await Bun.file(new URL("bun.lock", repo)).text();
    const manifest = await Bun.file(new URL("package.json", repo)).json();
    const current: string = manifest.dependencies[AGENT_FS_ADAPTER_NPM_PACKAGE];

    expect(() => assertLockfilePinned(lock, current)).not.toThrow();
    expect(() => assertLockfilePinned(lock, "9.9.9")).toThrow(
      `bun.lock still resolves ${AGENT_FS_ADAPTER_NPM_PACKAGE}@${current}; expected 9.9.9.`,
    );
    expect(() => assertLockfilePinned("{}", current)).toThrow("has no");
  });
});
