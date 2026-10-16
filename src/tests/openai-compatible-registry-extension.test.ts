/**
 * Proof that adding an OpenAI-compatible provider takes one registry entry:
 * a fake `testgw` entry must reach every derived surface
 * (`fixtures/openai-compatible-registry-extension.child.ts`).
 *
 * The proof mocks the registry module, and its consumers cache derivations of
 * the table at import (integration cards, picker constants) that no mock
 * restore can undo. It runs in its own `bun test` child so this process, and
 * every file sharing it in a single-process run, keeps the real table.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { modelGroupsForHarness } from "../../apps/ui/src/lib/agent-runtime-models";
import { INTEGRATIONS } from "../../apps/ui/src/lib/integrations-catalog";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const REPO_ROOT = join(import.meta.dir, "../..");
const CHILD = "./src/tests/fixtures/openai-compatible-registry-extension.child.ts";

test(
  "a testgw registry entry reaches every derived surface (child process)",
  async () => {
    const result = expectChildOk(
      await runChild([process.execPath, "test", CHILD], {
        cwd: REPO_ROOT,
        env: { ...process.env },
      }),
      "registry extension proof",
    );
    // bun test reports to stderr; 0 fail and every case ran.
    const report = `${result.stdout}\n${result.stderr}`;
    expect(report).toMatch(/\b6 pass\b/);
    expect(report).toMatch(/\b0 fail\b/);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test("this process still sees the real registry only", () => {
  expect(INTEGRATIONS.some((def) => def.id === "testgw")).toBe(false);
  const providers = modelGroupsForHarness("pi", [], {}).map((g) => g.provider);
  expect(providers).not.toContain("TestGW");
});
