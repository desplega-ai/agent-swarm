import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ImportConfigError, loadImportSources } from "../be/import/config";
import { ImportPackageError, loadDirPackage } from "../be/import/dir-source";
import type { ImportSource } from "../be/import/schema";
import {
  removePackages,
  SCRIPT,
  SKILL_MD,
  WORKFLOW_YAML,
  writePackage,
} from "./fixtures/import-package";

const source = (path: string): ImportSource => ({
  id: "team",
  type: "dir",
  path,
  onConflict: "noop",
});

async function configError(env: Record<string, string>): Promise<string[]> {
  try {
    await loadImportSources(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ImportConfigError);
    return (error as ImportConfigError).diagnostics;
  }
  throw new Error("expected an ImportConfigError");
}

async function packageError(path: string): Promise<string[]> {
  try {
    await loadDirPackage(source(path));
  } catch (error) {
    expect(error).toBeInstanceOf(ImportPackageError);
    return (error as ImportPackageError).diagnostics;
  }
  throw new Error("expected an ImportPackageError");
}

afterAll(removePackages);

describe("loadImportSources", () => {
  test("unset config means no sources", async () => {
    expect(await loadImportSources({})).toEqual([]);
    expect(await loadImportSources({ SWARM_IMPORT_SOURCES: "  " })).toEqual([]);
  });

  test("inline JSON parses and defaults onConflict to noop", async () => {
    const sources = await loadImportSources({
      SWARM_IMPORT_SOURCES: JSON.stringify([{ id: "team", type: "dir", path: "/pkg" }]),
    });
    expect(sources).toEqual([{ id: "team", type: "dir", path: "/pkg", onConflict: "noop" }]);
  });

  test("a YAML sources file parses", async () => {
    const dir = await writePackage({
      "sources.yaml": "- id: team\n  type: dir\n  path: /pkg\n  onConflict: overwrite\n",
    });
    const sources = await loadImportSources({
      SWARM_IMPORT_SOURCES_FILE: join(dir, "sources.yaml"),
    });
    expect(sources[0]?.onConflict).toBe("overwrite");
  });

  test("errors name the field and never echo the value", async () => {
    const secret = "sk-live-do-not-echo";
    const cases: Record<string, string>[] = [
      { SWARM_IMPORT_SOURCES: `[{"id": ${secret}}]` },
      {
        SWARM_IMPORT_SOURCES: JSON.stringify([
          { id: "team", type: "dir", path: secret, [secret]: secret },
        ]),
      },
      { SWARM_IMPORT_SOURCES: "[]", SWARM_IMPORT_SOURCES_FILE: `/${secret}` },
      { SWARM_IMPORT_SOURCES_FILE: `/nope/${secret}.json` },
    ];
    for (const env of cases) {
      const lines = await configError(env);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain(secret);
    }
    const fieldLines = await configError(cases[1] as Record<string, string>);
    expect(fieldLines).toContain("SWARM_IMPORT_SOURCES.0.path: must be an absolute path");
    expect(fieldLines).toContain("SWARM_IMPORT_SOURCES.0: unknown field");
  });

  test("duplicate source ids are rejected", async () => {
    const one = { id: "team", type: "dir", path: "/a" };
    const lines = await configError({ SWARM_IMPORT_SOURCES: JSON.stringify([one, one]) });
    expect(lines).toEqual(["SWARM_IMPORT_SOURCES.1.id: duplicate source id"]);
  });
});

describe("loadDirPackage", () => {
  test("a manifest package loads every kind", async () => {
    const dir = await writePackage({
      "swarm-import.yaml": `version: 1
workflows:
  - id: review
    file: flows/review.yaml
skills:
  - id: guide
    dir: skills/guide
scripts:
  - name: team-report
    file: scripts/report.ts
    description: Build the team report
agents:
  - name: Reviewer
    instructions: agents/reviewer.md
    skills: [guide]
`,
      "flows/review.yaml": WORKFLOW_YAML("team-review"),
      "skills/guide/SKILL.md": SKILL_MD("team-guide"),
      "skills/guide/files/checklist.md": "- [ ] tests\n",
      "scripts/report.ts": SCRIPT,
      "agents/reviewer.md": "# Reviewer\n",
    });
    const pkg = await loadDirPackage(source(dir));
    expect(pkg.workflows.map((w) => [w.key, w.spec.name])).toEqual([["review", "team-review"]]);
    expect(pkg.skills[0]?.spec.name).toBe("team-guide");
    expect(pkg.skills[0]?.spec.scope).toBe("global");
    expect(pkg.skills[0]?.files).toEqual([{ path: "checklist.md", content: "- [ ] tests\n" }]);
    expect(pkg.scripts[0]?.key).toBe("team-report");
    expect(pkg.agents).toEqual([
      {
        key: "name:Reviewer",
        agentId: null,
        agentName: "Reviewer",
        instructions: { text: "# Reviewer\n", hash: expect.any(String) },
        skills: ["guide"],
      },
    ]);
  });

  test("without a manifest the convention applies, and omitted kinds import nothing", async () => {
    const dir = await writePackage({ "workflows/review.yml": WORKFLOW_YAML("team-review") });
    const pkg = await loadDirPackage(source(dir));
    expect(pkg.workflows.map((w) => w.key)).toEqual(["review"]);
    expect(pkg.skills).toEqual([]);
    expect(pkg.scripts).toEqual([]);
    expect(pkg.agents).toEqual([]);
  });

  test("a malformed manifest fails without echoing its content", async () => {
    const secret = "sk-live-manifest";
    const unparsable = await writePackage({ "swarm-import.json": `{"workflows": ${secret}` });
    expect(await packageError(unparsable)).toEqual(["swarm-import.json: cannot parse as JSON"]);

    const badField = await writePackage({
      "swarm-import.yaml": `workflows:\n  - id: review\n    file: ../${secret}\n    ${secret}: 1\n`,
    });
    const lines = await packageError(badField);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines).toContain("manifest.workflows.0: unknown field");
    expect(lines.some((line) => line.startsWith("manifest.workflows.0.file:"))).toBe(true);
  });

  test("every invalid item is reported together", async () => {
    const dir = await writePackage({
      "swarm-import.yaml": `workflows:
  - id: bad
    file: workflows/bad.yaml
  - id: missing
    file: workflows/missing.yaml
skills:
  - id: guide
    dir: skills/guide
agents:
  - name: Reviewer
    skills: [nope]
  - name: Other
    id: also
`,
      "workflows/bad.yaml":
        "name: x\ndefinition:\n  nodes:\n    - id: a\n      type: no-such-node\n      config: {}\n",
      "skills/guide/SKILL.md": "no frontmatter",
    });
    const lines = await packageError(dir);
    expect(lines).toContain("manifest.agents.1: set exactly one of name or id");
    const fixed = await writePackage({
      "swarm-import.yaml": `workflows:
  - id: bad
    file: workflows/bad.yaml
  - id: missing
    file: workflows/missing.yaml
skills:
  - id: guide
    dir: skills/guide
agents:
  - name: Reviewer
    skills: [nope]
`,
      "workflows/bad.yaml":
        "name: x\ndefinition:\n  nodes:\n    - id: a\n      type: no-such-node\n      config: {}\n",
      "skills/guide/SKILL.md": "no frontmatter",
    });
    const all = await packageError(fixed);
    expect(all.some((line) => line.startsWith("workflow bad:"))).toBe(true);
    expect(all).toContain("workflow missing: workflows/missing.yaml not found");
    expect(all.some((line) => line.startsWith("skill guide:"))).toBe(true);
    expect(all).toContain("agent name:Reviewer: skills not declared in this package: nope");
  });

  test("a missing package root is reported", async () => {
    expect(await packageError("/definitely/not/here")).toEqual(["path: not a readable directory"]);
  });
});
