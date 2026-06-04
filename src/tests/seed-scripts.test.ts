import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { closeDb, initDb } from "../be/db";
import { getScript, listScripts, upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { typecheckScript } from "../be/scripts/typecheck";
import { runSeeder } from "../be/seed";
import { SEED_SCRIPTS, scriptsSeeder } from "../be/seed-scripts";
import compoundInsights from "../be/seed-scripts/catalog/compound-insights";
import opsCatalogAudit, {
  renderPage as renderOpsCatalogAuditPage,
} from "../be/seed-scripts/catalog/ops-catalog-audit";
import { extractScriptSignature } from "../scripts-runtime/extract-signature";
import { validateScriptImports } from "../scripts-runtime/import-allowlist";

const TEST_DB_PATH = "./test-seed-scripts.sqlite";

// Deterministic offline embedding so the seed never reaches out to OpenAI.
const fakeEmbeddingProvider = {
  name: "test/fake-seed-embedding",
  dimensions: 4,
  async embed(text: string) {
    return new Float32Array([text.length % 7, text.length % 5, text.length % 3, 1]);
  },
  async embedBatch(texts: string[]) {
    return Promise.all(texts.map((t) => this.embed(t)));
  },
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  setScriptEmbeddingProviderForTests(fakeEmbeddingProvider);
});

afterAll(async () => {
  closeDb();
  setScriptEmbeddingProviderForTests(null);
  await removeDbFiles(TEST_DB_PATH);
});

describe("seed-scripts catalog", () => {
  test("manifest holds 16 unique, well-described scripts", () => {
    expect(SEED_SCRIPTS.length).toBe(16);
    const names = SEED_SCRIPTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SEED_SCRIPTS) {
      expect(s.name).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(s.description.length).toBeGreaterThanOrEqual(40);
      expect(s.intent.length).toBeGreaterThanOrEqual(20);
      expect(s.source).toContain("export default");
      expect(s.source).toContain("argsSchema");
    }
  });

  test("every catalog script passes the import allowlist and the script typecheck", () => {
    const failures: string[] = [];
    for (const s of SEED_SCRIPTS) {
      const imports = validateScriptImports(s.source);
      if (!imports.ok) failures.push(`${s.name}: import — ${imports.diagnostic}`);
      const tc = typecheckScript(s.source);
      if (!tc.ok) failures.push(`${s.name}: typecheck — ${tc.diagnostics.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  });

  test("every catalog script exposes a documented default export", () => {
    for (const s of SEED_SCRIPTS) {
      const sig = extractScriptSignature(s.source);
      expect(sig.description.length, `${s.name} is missing a JSDoc summary`).toBeGreaterThan(0);
    }
  });

  test("scriptsSeeder declares the script kind and one item per catalog entry", async () => {
    expect(scriptsSeeder.kind).toBe("script");
    const items = await scriptsSeeder.items();
    expect(items.length).toBe(SEED_SCRIPTS.length);
    for (const item of items) {
      expect(typeof item.key).toBe("string");
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("scriptsSeeder seeds the whole catalog at global scope", async () => {
    const result = await runSeeder(scriptsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(SEED_SCRIPTS.length);

    const globals = listScripts({ scope: "global" });
    for (const s of SEED_SCRIPTS) {
      const row = globals.find((g) => g.name === s.name);
      expect(row, `${s.name} was not seeded`).toBeDefined();
      expect(row?.scope).toBe("global");
      expect(row?.scopeId).toBeNull();
      expect(row?.isScratch).toBe(false);
      expect(row?.typeChecked).toBe(true);
    }
  });

  test("re-seeding is idempotent — pristine, unchanged scripts are skipped", async () => {
    const result = await runSeeder(scriptsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUnchanged).toBe(SEED_SCRIPTS.length);
    expect(result.skippedUserModified).toBe(0);
  });

  test("a user-modified script is preserved, not overwritten, on re-seed", async () => {
    // Simulate a user editing one seeded script's source upstream.
    const target = SEED_SCRIPTS[0];
    const userSource = `${target.source}\n// edited by a user\n`;
    await upsertScriptByName({
      name: target.name,
      scope: "global",
      scopeId: null,
      source: userSource,
      description: target.description,
      intent: target.intent,
      signatureJson: JSON.stringify(extractScriptSignature(target.source)),
      fsMode: "none",
      agentId: null,
      isScratch: false,
      typeChecked: true,
    });

    const result = await runSeeder(scriptsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUserModified).toBe(1);
    expect(result.skippedUnchanged).toBe(SEED_SCRIPTS.length - 1);

    // The user's edit survived — the seed did not clobber it.
    const row = getScript({ name: target.name, scope: "global" });
    expect(row?.source).toBe(userSource);
  });

  test("compound-insights decodes numeric-key SQLite blob objects for similarity checks", async () => {
    function encodedVector(values: number[]): Record<string, number> {
      const bytes = new Uint8Array(new Float32Array(values).buffer);
      return Object.fromEntries(Array.from(bytes.entries()).map(([i, byte]) => [String(i), byte]));
    }

    const queries: string[] = [];
    const ctx = {
      swarm: {
        async db_query({ sql }: { sql: string }) {
          queries.push(sql);
          if (sql.includes("SELECT scope, source, count(*) as cnt")) {
            return {
              columns: ["scope", "source", "cnt", "zeroAccess"],
              rows: [["agent", "session_summary", 2, 0]],
            };
          }
          if (sql.includes("SELECT id, name, source, accessCount, embedding")) {
            return {
              columns: ["id", "name", "source", "accessCount", "embedding"],
              rows: [
                ["a", "first", "session_summary", 3, encodedVector([1, 0, 0, 0])],
                ["b", "second", "task_completion", 2, encodedVector([0.9, 0.1, 0, 0])],
              ],
            };
          }
          if (sql.includes("SELECT source, count(*) as count")) {
            return { columns: ["source", "count"], rows: [] };
          }
          return { columns: [], rows: [] };
        },
      },
    };

    const result = await compoundInsights(
      {
        days: 7,
        includeToolUsage: false,
        includeScheduleHealth: false,
        includeScriptCandidates: false,
        includeByAgent: false,
      },
      ctx,
    );

    expect(queries.some((sql) => sql.includes("embedding IS NOT NULL"))).toBe(true);
    expect(result.memoryHealth.pollution.similarityCheck.sampledAutoSnapshots).toBe(2);
    expect(result.memoryHealth.pollution.similarityCheck.strongestAutoSnapshotPair).toMatchObject({
      a: { id: "a", name: "first", source: "session_summary" },
      b: { id: "b", name: "second", source: "task_completion" },
    });
    expect(
      result.memoryHealth.pollution.similarityCheck.strongestAutoSnapshotPair.similarity,
    ).toBeGreaterThan(0.99);
  });

  test("ops-catalog-audit clusters schedule, workflow, and prompt findings by goal", async () => {
    const queries: string[] = [];
    const result = await opsCatalogAudit(
      { nowIso: "2026-06-04T12:00:00.000Z", publishPage: false },
      {
        swarm: {
          async db_query({ sql }: { sql: string }) {
            queries.push(sql);
            if (sql.includes("FROM scheduled_tasks")) {
              return {
                columns: [
                  "id",
                  "name",
                  "description",
                  "cronExpression",
                  "intervalMs",
                  "taskTemplate",
                  "taskType",
                  "tags",
                  "priority",
                  "targetAgentId",
                  "enabled",
                  "lastRunAt",
                  "nextRunAt",
                  "createdByAgentId",
                  "timezone",
                  "consecutiveErrors",
                  "scheduleType",
                  "targetAgentName",
                  "targetAgentRole",
                  "targetAgentDescription",
                  "targetAgentCapabilities",
                  "targetAgentProvider",
                  "targetAgentHarnessProvider",
                ],
                rows: [
                  [
                    "sched-a",
                    "repo-ci-audit",
                    "",
                    "0 * * * *",
                    null,
                    "Run gh pr checks and bun test in the repo",
                    "feature",
                    "[]",
                    50,
                    null,
                    1,
                    "2026-05-01T00:00:00.000Z",
                    null,
                    null,
                    "UTC",
                    0,
                    "recurring",
                    null,
                    null,
                    null,
                    null,
                    null,
                    null,
                  ],
                  [
                    "sched-b",
                    "memory-gate-597",
                    "temporary monitor until 2026-06-01",
                    "0 * * * *",
                    null,
                    "Check memory gate",
                    "monitor",
                    "[]",
                    50,
                    "agent-ops",
                    1,
                    "2026-06-04T00:00:00.000Z",
                    "2026-06-04T13:00:00.000Z",
                    null,
                    "UTC",
                    0,
                    "recurring",
                    "Ops Reviewer",
                    "ops",
                    "operations reviewer",
                    '["ops"]',
                    "opencode",
                    "opencode",
                  ],
                ],
              };
            }
            if (sql.includes("FROM workflows")) {
              return {
                columns: [
                  "id",
                  "name",
                  "description",
                  "enabled",
                  "definition",
                  "triggers",
                  "input",
                  "triggerSchema",
                  "createdAt",
                  "lastUpdatedAt",
                ],
                rows: [
                  [
                    "wf-smoke",
                    "gsc-runtime-smoke",
                    "temporary smoke fixture",
                    1,
                    JSON.stringify({ nodes: [{ id: "a", type: "swarm-script" }] }),
                    "[]",
                    null,
                    null,
                    "2026-06-01T00:00:00.000Z",
                    "2026-06-01T00:00:00.000Z",
                  ],
                  [
                    "wf-gate",
                    "content-litmus-gate",
                    "quality gate",
                    1,
                    JSON.stringify({ nodes: [{ id: "judge", type: "raw-llm" }] }),
                    "[]",
                    null,
                    null,
                    "2026-06-01T00:00:00.000Z",
                    "2026-06-01T00:00:00.000Z",
                  ],
                ],
              };
            }
            if (sql.includes("FROM prompt_templates")) {
              return {
                columns: [
                  "id",
                  "eventType",
                  "scope",
                  "scopeId",
                  "state",
                  "body",
                  "isDefault",
                  "version",
                  "createdBy",
                  "updatedAt",
                ],
                rows: [
                  [
                    "prompt-a",
                    "system.agent.role",
                    "global",
                    null,
                    "enabled",
                    "Use https://api.example-swarm.dev and do not browse. You must browse.",
                    1,
                    1,
                    "system",
                    "2026-06-01T00:00:00.000Z",
                  ],
                  [
                    "prompt-b",
                    "legacy.only",
                    "global",
                    null,
                    "enabled",
                    "Duplicate body",
                    1,
                    1,
                    "system",
                    "2026-06-01T00:00:00.000Z",
                  ],
                  [
                    "prompt-c",
                    "slack.assistant.greeting",
                    "global",
                    null,
                    "enabled",
                    "Duplicate body",
                    1,
                    1,
                    "system",
                    "2026-06-01T00:00:00.000Z",
                  ],
                ],
              };
            }
            if (sql.includes("FROM skills")) {
              return {
                columns: ["name", "count", "locations"],
                rows: [["pages", 2, "global:global, swarm:global"]],
              };
            }
            return { columns: [], rows: [] };
          },
        },
      },
    );

    const findingIds = (items: Array<{ id: string }>) => items.map((finding) => finding.id);

    expect(queries.length).toBe(4);
    expect(result.summary.findingsTotal).toBeGreaterThanOrEqual(8);
    expect(findingIds(result.goals.schedules.findings)).toEqual(
      expect.arrayContaining([
        "schedules.duplicate-crons",
        "schedules.dead-or-stale",
        "schedules.temporary-self-lift",
        "schedules.rule-13-15-routing",
      ]),
    );
    expect(findingIds(result.goals.workflows.findings)).toEqual(
      expect.arrayContaining(["workflows.enabled-fixtures", "workflows.structured-output-gaps"]),
    );
    expect(findingIds(result.goals.promptsTemplates.findings)).toEqual(
      expect.arrayContaining([
        "prompts.registry-drift",
        "prompts.redundant-bodies",
        "prompts.stale-urls-hosts",
        "prompts.contradictory-instructions",
        "prompts.system-default-skill-duplicates",
      ]),
    );
  });

  test("ops-catalog-audit renders a summary-first designed HTML report", () => {
    const html = renderOpsCatalogAuditPage({
      generatedAt: "2026-06-04T12:00:00.000Z",
      summary: {
        schedulesEnabled: 40,
        workflowsTotal: 33,
        workflowsEnabled: 28,
        promptTemplates: 76,
        findingsTotal: 2,
      },
      goals: {
        schedules: {
          goal: "Reduce schedule cost/context waste and prevent misrouted code work.",
          findingCount: 1,
          checks: { duplicateCronGroups: 1, routingRisks: 1 },
          findings: [
            {
              id: "schedules.rule-13-15-routing",
              severity: "critical",
              summary: "1 enabled code-work schedule is not pinned to a code-capable worker.",
              action: "Set targetAgentId to a code-capable worker.",
              samples: [
                { id: "sched-a", name: "repo-ci-audit", reason: "pool-targeted code work" },
              ],
            },
          ],
        },
        workflows: {
          goal: "Separate load-bearing workflows from fixtures and enforce deterministic gate outputs.",
          findingCount: 0,
          checks: { enabledFixtures: 0, structuredOutputGaps: 0 },
          findings: [],
        },
        promptsTemplates: {
          goal: "Keep prompt registry, runtime defaults, host guidance, and skill seed blocks aligned.",
          findingCount: 1,
          checks: { staleUrlPrompts: 1 },
          findings: [
            {
              id: "prompts.stale-urls-hosts",
              severity: "high",
              summary: "1 prompt template contains stale/local/example hosts.",
              action: "Replace hardcoded hosts with runtime env-var guidance.",
              samples: [{ id: "prompt-a", eventType: "system.agent.role", match: "localhost" }],
            },
          ],
        },
      },
    });

    expect(html).toContain("<main>");
    expect(html).toContain('class="metrics"');
    expect(html).toContain("<strong>40</strong><span>Schedules enabled</span>");
    expect(html).toContain("schedules.rule-13-15-routing");
    expect(html).toContain('class="finding danger"');
    expect(html).toContain("<details>");
    expect(html).toContain("Compressed JSON appendix");
    expect(html).toContain('<div class="sample-table"');
    expect(html).toContain("@media (max-width: 860px)");
    expect(html).not.toContain("<ul>");
  });
});

/**
 * Regression guard for the production seeding failure: in the `bun build
 * --compile` binary, `node_modules` is NOT shipped, so `typecheckScript` could
 * not resolve `import { z } from "zod"` (TS2307) and every catalog script
 * failed to seed. The Dockerfile now stages zod's declaration files under
 * `SCRIPT_TYPES_DIR`; these tests prove resolution works from that staged copy
 * alone — they deliberately do NOT rely on the repo's dev `node_modules`.
 */
describe("script typecheck resolves zod in compiled-binary mode", () => {
  const ENV_KEY = "SCRIPT_TYPES_DIR";
  const originalEnv = process.env[ENV_KEY];
  const tmpDirs: string[] = [];

  // Use the OS temp dir, NOT a path inside the repo: TypeScript's module
  // resolution walks UP looking for `node_modules`, so a base dir under the
  // repo would silently resolve zod from the repo's dev `node_modules` and mask
  // the very gap these tests exist to catch.
  async function makeTmpDir(): Promise<string> {
    const dir = join(tmpdir(), `swarm-zod-types-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  // Mirror the Dockerfile builder step: stage ONLY zod's declaration files and
  // package.json manifests into `<baseDir>/node_modules/zod`. If this slim set
  // is insufficient, the typecheck below fails — exactly as production would.
  async function stageSlimZod(baseDir: string): Promise<void> {
    const src = "./node_modules/zod";
    const dest = join(baseDir, "node_modules", "zod");
    for (const rel of await readdir(src, { recursive: true })) {
      const keep =
        rel.endsWith(".d.ts") || rel.endsWith(".d.cts") || basename(rel) === "package.json";
      if (!keep) continue;
      const target = join(dest, rel);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(src, rel), target);
    }
  }

  afterAll(async () => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  test("every catalog script typechecks against the staged (declaration-only) zod copy", async () => {
    const base = await makeTmpDir();
    await stageSlimZod(base);
    process.env[ENV_KEY] = base;

    const failures: string[] = [];
    for (const s of SEED_SCRIPTS) {
      const tc = typecheckScript(s.source);
      if (!tc.ok) failures.push(`${s.name}: ${tc.diagnostics.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  });

  test("typecheck fails when zod is not staged — the production gap, now guarded", async () => {
    // An empty SCRIPT_TYPES_DIR simulates the compiled binary BEFORE this fix:
    // no node_modules/zod on disk. The dev-node_modules fallback masked this in
    // CI; pinning resolution to SCRIPT_TYPES_DIR makes the gap reproducible.
    const empty = await makeTmpDir();
    process.env[ENV_KEY] = empty;

    const result = typecheckScript(SEED_SCRIPTS[0].source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.join(" ")).toContain("TS2307");
    }
  });
});
