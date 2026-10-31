import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Coverage,
  type CoverageManifest,
  loadManifest,
  strictFailures,
} from "../../scripts/e2e/coverage";
import { embeddingFor, synthesizeFromSchema } from "../../scripts/e2e/mocks/llm";

const REPO_MANIFEST = join(import.meta.dir, "../../scripts/e2e/coverage-manifest.json");

function coverage(overrides: Partial<Coverage> = {}): Coverage {
  const empty = { total: 0, covered: 0, excluded: 0, percent: 100, uncovered: [] };
  return {
    routes: { ...empty, byGroup: {}, unknown: [] },
    mcpTools: { ...empty },
    nodeTypes: { ...empty },
    stateSurfaces: [],
    flows: [],
    scenariosWithoutFlow: [],
    staleExclusions: [],
    deadExclusions: [],
    unknownFlowScenarios: [],
    latency: { byGroup: {}, overall: { count: 0, p50: 0, p95: 0, max: 0 } },
    ...overrides,
  };
}

describe("e2e strict coverage contract", () => {
  test("holds when everything is covered and the manifest is clean", () => {
    expect(strictFailures(coverage())).toEqual([]);
  });

  test("names every uncovered surface, stale and dead exclusions, and failed flows", () => {
    const failures = strictFailures(
      coverage({
        routes: {
          total: 2,
          covered: 1,
          excluded: 0,
          percent: 50,
          uncovered: ["GET /api/missing"],
          byGroup: {},
          unknown: [],
        },
        mcpTools: { total: 1, covered: 0, excluded: 0, percent: 0, uncovered: ["kv-get"] },
        nodeTypes: { total: 1, covered: 0, excluded: 0, percent: 0, uncovered: ["wait"] },
        staleExclusions: ["route POST /api/old"],
        deadExclusions: ["mcp tool gone-tool"],
        unknownFlowScenarios: ["no-such-scenario"],
        flows: [
          {
            name: "scripts",
            description: "",
            scenarios: ["script-run"],
            status: "fail",
            detail: "not run: script-run",
          },
        ],
      }),
    );
    expect(failures).toHaveLength(7);
    expect(failures.join("\n")).toContain("GET /api/missing");
    expect(failures.join("\n")).toContain("kv-get");
    expect(failures.join("\n")).toContain("wait");
    expect(failures.join("\n")).toContain("POST /api/old");
    expect(failures.join("\n")).toContain("gone-tool");
    expect(failures.join("\n")).toContain("no-such-scenario");
    expect(failures.join("\n")).toContain("scripts: not run: script-run");
  });

  test("state surfaces fail on values never produced, values outside the universe, and orphan scenarios", () => {
    const failures = strictFailures(
      coverage({
        stateSurfaces: [
          {
            name: "script-run-statuses",
            total: 3,
            covered: 1,
            excluded: 1,
            percent: 33.3,
            uncovered: ["aborted_limit", "paused"],
            unexpected: ["exploded"],
          },
        ],
        scenariosWithoutFlow: ["lonely-scenario"],
      }),
    );
    expect(failures).toHaveLength(3);
    expect(failures[0]).toContain("aborted_limit");
    expect(failures[1]).toContain("exploded");
    expect(failures[2]).toContain("lonely-scenario");
  });

  test("the committed manifest parses and every exclusion carries a reason", async () => {
    const manifest: CoverageManifest = await loadManifest(REPO_MANIFEST);
    for (const entry of manifest.routes) {
      expect(entry.operation).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \//);
      expect(entry.reason.length).toBeGreaterThanOrEqual(10);
    }
    for (const entry of [...manifest.mcpTools, ...manifest.nodeTypes]) {
      expect(entry.reason.length).toBeGreaterThanOrEqual(10);
    }
    for (const [name, flow] of Object.entries(manifest.flows)) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(flow.scenarios.length).toBeGreaterThan(0);
    }
    expect(manifest.stateSurfaces.length).toBeGreaterThan(0);
    for (const surface of manifest.stateSurfaces) {
      expect(surface.query).toMatch(/^SELECT /);
      for (const entry of surface.excluded) expect(surface.universe).toContain(entry.value);
    }
  });

  test("a state surface with a non-SELECT query or a value outside its universe is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-manifest-"));
    const bad = join(dir, "bad-query.json");
    await writeFile(
      bad,
      JSON.stringify({
        stateSurfaces: [{ name: "x", query: "DELETE FROM scripts", universe: ["a"], excluded: [] }],
      }),
    );
    await expect(loadManifest(bad)).rejects.toThrow(/SELECT/);
    const orphan = join(dir, "orphan-exclusion.json");
    await writeFile(
      orphan,
      JSON.stringify({
        stateSurfaces: [
          {
            name: "x",
            query: "SELECT DISTINCT status AS value FROM scripts",
            universe: ["a"],
            excluded: [
              { value: "a", reason: "transient between two ticks" },
              { value: "a", reason: "repeated on purpose" },
            ],
          },
        ],
      }),
    );
    await expect(loadManifest(orphan)).rejects.toThrow(/repeats a value/);
  });

  test("a manifest entry without a reason or with a duplicate is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-manifest-"));
    const noReason = join(dir, "no-reason.json");
    await writeFile(
      noReason,
      JSON.stringify({ routes: [{ operation: "GET /api/x", reason: "later" }] }),
    );
    await expect(loadManifest(noReason)).rejects.toThrow(/reason of at least 10/);
    const duplicate = join(dir, "duplicate.json");
    await writeFile(
      duplicate,
      JSON.stringify({
        mcpTools: [
          { name: "kv-get", reason: "needs a live provider token" },
          { name: "kv-get", reason: "needs a live provider token" },
        ],
      }),
    );
    await expect(loadManifest(duplicate)).rejects.toThrow(/duplicates/);
  });
});

describe("e2e mock inference host", () => {
  test("synthesizes a value for every declared property of a JSON schema", () => {
    const value = synthesizeFromSchema({
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string", enum: ["approve", "reject"] },
        score: { type: "integer", minimum: 3 },
        tags: { type: "array", items: { type: "string" } },
        nested: { type: "object", properties: { ok: { type: "boolean" } } },
        when: { type: "string", format: "date-time" },
      },
    }) as Record<string, unknown>;
    expect(value.verdict).toBe("approve");
    expect(value.score).toBe(3);
    expect(value.tags).toEqual(["e2e"]);
    expect(value.nested).toEqual({ ok: true });
    expect(typeof value.when).toBe("string");
  });

  test("embeddings are deterministic unit vectors that reward shared words", () => {
    const a = embeddingFor("deploy the api server", 64);
    const b = embeddingFor("deploy the api server", 64);
    const c = embeddingFor("deploy the api gateway", 64);
    const d = embeddingFor("bake sourdough bread", 64);
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    const norm = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
    const dot = (x: number[], y: number[]) =>
      x.reduce((sum, value, i) => sum + value * (y[i] ?? 0), 0);
    expect(dot(a, c)).toBeGreaterThan(dot(a, d));
  });
});
