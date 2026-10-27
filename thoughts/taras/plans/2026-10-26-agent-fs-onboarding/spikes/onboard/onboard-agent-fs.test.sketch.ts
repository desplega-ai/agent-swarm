// @ts-nocheck: spike code, not typechecked by the repo (imports resolve in the spike worktree only).
// SKETCH for src/tests/onboard-agent-fs.test.ts (not run, not in the repo).
// onboard tests need no fs or prompt stubs: generateCompose/generateEnv/generateManifest are pure,
// state is `{ ...INITIAL_STATE, ...overrides }` (see onboard-compose.test.ts:7-9).
// `bundleAgentFs` is the proposed new OnboardState field. INITIAL_STATE sets it to false.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompose } from "../commands/onboard/compose-generator.ts";
import { generateEnv } from "../commands/onboard/env-generator.ts";
import { INITIAL_STATE, type OnboardState } from "../commands/onboard/types.ts";
import { readAgentFsImageTag } from "../../scripts/agent-fs-version-utils.ts";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc.ts";

const make = (o: Partial<OnboardState>): OnboardState => ({ ...INITIAL_STATE, ...o });
const solo = {
  presetId: "solo",
  services: [{ template: "official/coder", displayName: "Coder", count: 1, role: "coder" }],
  agentIds: { "worker-coder": "coder-uuid" },
};
const headers = (y: string) => y.match(/^ {2}[a-z][\w-]+:$/gm) ?? [];

describe("agent-fs bundle in onboard output", () => {
  test("INITIAL_STATE keeps the bundle off", () => {
    expect(INITIAL_STATE.bundleAgentFs).toBe(false);
  });

  test("flag off: no agent-fs, tei or new env anywhere", () => {
    const yml = generateCompose(make(solo));
    expect(headers(yml)).toEqual(["  swarm-api:", "  worker-coder:"]);
    for (const s of ["agent-fs", "tei", "COMB_ENABLED", "EMBEDDING_", "AGENT_FS_"]) {
      expect(yml).not.toContain(s);
    }
    const env = generateEnv(make(solo));
    for (const s of ["COMB_ENABLED", "EMBEDDING_", "AGENT_FS_", "TEI_IMAGE"]) {
      expect(env).not.toContain(s);
    }
  });

  test("flag on: adds agent-fs + tei, API env, depends_on, volumes, agent env", () => {
    const yml = generateCompose(make({ ...solo, bundleAgentFs: true }));
    expect(headers(yml)).toEqual(["  swarm-api:", "  worker-coder:", "  agent-fs:", "  tei:"]);
    expect(yml).toContain("AGENT_FS_STORAGE_PROVIDER=local");
    expect(yml).toContain("AGENT_FS_API_URL=http://agent-fs:7433");
    expect(yml.match(/AGENT_FS_API_URL=/g)).toHaveLength(2); // api + 1 agent
    expect(yml).toContain("agent_fs_data:/data");
    expect(yml).toContain("text-embeddings-inference");
    expect(yml).not.toContain("minio");
    // TEI is not published to the host
    expect(yml.split("  tei:")[1]).not.toContain("ports:");
  });

  test("flag on: agent-fs pin equals the Helm chart tag", async () => {
    const yml = generateCompose(make({ ...solo, bundleAgentFs: true }));
    const values = "charts/agent-swarm/values.yaml";
    const tag = readAgentFsImageTag(await Bun.file(values).text(), values);
    expect(yml).toContain(`ghcr.io/desplega-ai/agent-fs:${tag}`);
  });

  test("flag on: env block", () => {
    const env = generateEnv(make({ ...solo, bundleAgentFs: true }));
    expect(env).toContain("COMB_ENABLED=true");
    expect(env).toContain("EMBEDDING_DIMENSIONS=768");
  });

  test("--yes writes the flag path without Docker (dry run writes nothing)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onboard-afs-"));
    try {
      const r = await runChild(
        ["bun", new URL("../cli.tsx", import.meta.url).pathname, "onboard", "--yes", "--preset=solo", "--dry-run"],
        { cwd: dir, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "example-test-oauth" } },
      );
      expect(r.exitCode).toBe(0);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, CHILD_PROCESS_TEST_BUDGET_MS);
});
