import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashScenario, normalizeSourceTokens } from "../src/scenario-hash.ts";
import type { Scenario } from "../src/types.ts";
import { scenarios } from "./index.ts";
import { SCENARIO_HASHES } from "./scenario-hashes.ts";
import { SUITE_SCENARIO_VERSIONS, SUITE_VERSION, suiteVersionFor } from "./suite.ts";

describe("scenario versioning", () => {
  test("every registered scenario has a positive integer version", () => {
    for (const s of scenarios) {
      expect({ id: s.id, ok: Number.isInteger(s.version) && s.version >= 1 }).toEqual({
        id: s.id,
        ok: true,
      });
    }
  });

  test("the suite manifest lists exactly the registered scenarios at their current versions", () => {
    const registered = Object.fromEntries(scenarios.map((s) => [s.id, s.version]));
    expect(SUITE_SCENARIO_VERSIONS).toEqual(registered);
  });

  test("suiteVersionFor names the suite only for a manifest scenario at its manifest version", () => {
    const first = scenarios[0] as Scenario;
    expect(suiteVersionFor(first.id, first.version)).toBe(SUITE_VERSION);
    expect(suiteVersionFor(first.id, first.version + 1)).toBeNull();
    expect(suiteVersionFor("not-in-the-suite", 1)).toBeNull();
  });

  test("a scenario's content changes only together with its version (hash pinned per version)", () => {
    for (const s of scenarios) {
      const history = SCENARIO_HASHES[s.id];
      if (!history || history.length === 0) {
        throw new Error(
          `${s.id}: no pinned hash. Run \`bun scripts/scenario-hash.ts ${s.id}\` and add it to scenarios/scenario-hashes.ts.`,
        );
      }
      const versions = history.map((h) => h.version);
      expect({
        id: s.id,
        strictlyIncreasing: versions.every((v, i) => i === 0 || v > versions[i - 1]!),
      }).toEqual({
        id: s.id,
        strictlyIncreasing: true,
      });
      const latest = history[history.length - 1]!;
      if (latest.version !== s.version) {
        throw new Error(
          `${s.id}: version is ${s.version} but the latest pinned hash is for version ${latest.version}. ` +
            "Append { version, hash } from `bun scripts/scenario-hash.ts` to scenarios/scenario-hashes.ts.",
        );
      }
      const current = hashScenario(s);
      if (current !== latest.hash) {
        throw new Error(
          `${s.id}: prompt, fixture or check changed (hash ${current}, pinned ${latest.hash} for v${latest.version}). ` +
            "Bump the scenario's `version`, append the new { version, hash } to scenarios/scenario-hashes.ts " +
            "and add a line to scenarios/CHANGELOG.md. Do not edit the old entry.",
        );
      }
    }
  });

  test("no scenario is pinned that is not registered", () => {
    const registered = new Set(scenarios.map((s) => s.id));
    expect(Object.keys(SCENARIO_HASHES).filter((id) => !registered.has(id))).toEqual([]);
  });
});

describe("hashScenario", () => {
  const base = scenarios.find((s) => s.id === "sql-audit") as Scenario;

  test("is stable across calls", () => {
    expect(hashScenario(base)).toBe(hashScenario(base));
  });

  test("changes when a task prompt changes", () => {
    const edited: Scenario = {
      ...base,
      tasks: base.tasks.map((t, i) =>
        i === 0 ? { ...t, description: `${t.description} Also be careful.` } : t,
      ),
    };
    expect(hashScenario(edited)).not.toBe(hashScenario(base));
  });

  test("changes when a rubric, weight or timeout changes", () => {
    expect(hashScenario({ ...base, timeoutMs: (base.timeoutMs ?? 0) + 1 })).not.toBe(
      hashScenario(base),
    );
    const dims = base.outcome.dimensions ?? [];
    const reweighted: Scenario = {
      ...base,
      outcome: {
        ...base.outcome,
        dimensions: dims.map((d, i) => (i === 0 ? { ...d, weight: d.weight + 1 } : d)),
      },
    };
    expect(hashScenario(reweighted)).not.toBe(hashScenario(base));
  });

  test("ignores name, description and version", () => {
    expect(
      hashScenario({
        ...base,
        name: "renamed",
        description: "reworded",
        version: base.version + 5,
      }),
    ).toBe(hashScenario(base));
  });

  test("does not depend on object key order", () => {
    const shuffled = Object.fromEntries(Object.entries(base).reverse()) as unknown as Scenario;
    expect(hashScenario(shuffled)).toBe(hashScenario(base));
  });

  test("changes when a referenced fixture changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "scenario-hash-"));
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, `${base.id}.ts`), "export const x = 1;\n");
    writeFileSync(join(dir, "fixtures", "sql-audit-history.sql"), "INSERT INTO t VALUES (1);\n");
    const before = hashScenario(base, { scenariosDir: dir });
    writeFileSync(join(dir, "fixtures", "sql-audit-history.sql"), "INSERT INTO t VALUES (2);\n");
    expect(hashScenario(base, { scenariosDir: dir })).not.toBe(before);
  });

  test("changes when a file under the scenario's own fixtures/<id>/ directory changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "scenario-hash-"));
    mkdirSync(join(dir, "fixtures", base.id, "repo"), { recursive: true });
    writeFileSync(join(dir, "fixtures", "sql-audit-history.sql"), "INSERT INTO t VALUES (1);\n");
    writeFileSync(join(dir, `${base.id}.ts`), "export const x = 1;\n");
    const hidden = join(dir, "fixtures", base.id, "repo", "hidden.test.ts.txt");
    writeFileSync(hidden, "test one\n");
    const before = hashScenario(base, { scenariosDir: dir });
    writeFileSync(hidden, "test two\n");
    expect(hashScenario(base, { scenariosDir: dir })).not.toBe(before);
    writeFileSync(join(dir, "fixtures", base.id, "repo", "added.txt"), "new file\n");
    expect(hashScenario(base, { scenariosDir: dir })).not.toBe(before);
  });

  test("changes when the scenario source changes, but not for comments or formatting", () => {
    const dir = mkdtempSync(join(tmpdir(), "scenario-hash-"));
    mkdirSync(join(dir, "fixtures"));
    writeFileSync(join(dir, "fixtures", "sql-audit-history.sql"), "INSERT INTO t VALUES (1);\n");
    const write = (text: string) => writeFileSync(join(dir, `${base.id}.ts`), text);
    write("const answer = /\\b12\\b/;\nexport const check = (s: string) => answer.test(s);\n");
    const before = hashScenario(base, { scenariosDir: dir });

    write(
      "// the answer key\nconst answer =   /\\b12\\b/;\n\n\nexport const check = (s: string) =>\n  answer.test(s); /* trailing */\n",
    );
    expect(hashScenario(base, { scenariosDir: dir })).toBe(before);

    write("const answer = /\\b13\\b/;\nexport const check = (s: string) => answer.test(s);\n");
    expect(hashScenario(base, { scenariosDir: dir })).not.toBe(before);
  });

  test("normalizeSourceTokens drops comments and layout", () => {
    expect(normalizeSourceTokens("a  =  1; // note\n/* x */ b = 2;")).toBe(
      normalizeSourceTokens("a = 1;\nb = 2;"),
    );
  });
});
