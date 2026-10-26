import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectDocsPages,
  coverageErrors,
  INDEX_END,
  INDEX_START,
  renderDocsIndex,
  replaceIndexBlock,
  SKILL_CONTENT_PATH,
} from "../../scripts/build-docs-index";
import { loadSeedSkills } from "../be/seed-skills";

const page = (frontmatter: string, body = "Body.\n") => `---\n${frontmatter}\n---\n\n${body}`;

describe("docs index (real docs tree)", () => {
  test("every playbook is in the index and the coverage rules pass", async () => {
    const pages = await collectDocsPages();
    expect(coverageErrors(pages)).toEqual([]);

    const index = renderDocsIndex(pages);
    const playbooks = pages.filter((p) => p.path.startsWith("playbooks/"));
    expect(playbooks.length).toBeGreaterThan(10);
    for (const playbook of playbooks) {
      expect(index).toContain(`(https://docs.agent-swarm.dev/docs/${playbook.slug})`);
    }
    // Positive control: a known playbook carries its trigger.
    expect(index).toContain(
      "[Open Oncall](https://docs.agent-swarm.dev/docs/playbooks/open-oncall). When: ",
    );
    // Negative control: opted-out pages are reference only, release notes are skipped.
    expect(index).toContain("(https://docs.agent-swarm.dev/docs/playbooks). Reference.");
    expect(index).not.toContain("/docs/releases/");
  });

  test("the committed skill body matches the generator", async () => {
    const content = await Bun.file(SKILL_CONTENT_PATH).text();
    const regenerated = replaceIndexBlock(content, renderDocsIndex(await collectDocsPages()));
    expect(content).toBe(regenerated);
  });

  test("the generator is deterministic", async () => {
    const first = renderDocsIndex(await collectDocsPages());
    const second = renderDocsIndex(await collectDocsPages());
    expect(second).toBe(first);
  });

  test("the seeded skill is a system default and carries the index", async () => {
    const skill = (await loadSeedSkills()).find((s) => s.name === "swarm-docs");
    expect(skill?.systemDefault).toBe(true);
    expect(skill?.content).toContain("https://docs.agent-swarm.dev/docs/playbooks/open-oncall");
  });
});

describe("docs index (fixture tree)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "docs-index-"));
    await mkdir(join(root, "playbooks"), { recursive: true });
    await mkdir(join(root, "guides"), { recursive: true });
    await mkdir(join(root, "releases"), { recursive: true });
    await Bun.write(join(root, "meta.json"), JSON.stringify({ pages: ["index", "playbooks"] }));
    await Bun.write(join(root, "index.mdx"), page("title: Home"));
    await Bun.write(
      join(root, "playbooks", "meta.json"),
      JSON.stringify({ pages: ["index", "b", "---Separator---", "a"] }),
    );
    await Bun.write(
      join(root, "playbooks", "index.mdx"),
      page("title: Playbooks\nagent:\n  offer: false"),
    );
    await Bun.write(
      join(root, "playbooks", "a.mdx"),
      page('title: A\nagent:\n  when: "Someone wants A"\n  template: "community/a"'),
    );
    await Bun.write(join(root, "playbooks", "b.mdx"), page("title: B"));
    await Bun.write(
      join(root, "guides", "g.mdx"),
      page("title: G\nagent:\n  offer: true\n  notWhen: never"),
    );
    await Bun.write(join(root, "releases", "r.mdx"), page("title: R"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("orders by meta.json, appends unlisted folders, and skips releases", async () => {
    const pages = await collectDocsPages(root);
    expect(pages.map((p) => p.path)).toEqual([
      "index",
      "playbooks/index",
      "playbooks/b",
      "playbooks/a",
      "guides/g",
    ]);
    expect(pages.map((p) => p.slug)).toEqual([
      "",
      "playbooks",
      "playbooks/b",
      "playbooks/a",
      "guides/g",
    ]);
  });

  test("a playbook without when, and an offered guide without when, fail coverage", async () => {
    const errors = coverageErrors(await collectDocsPages(root));
    expect(errors).toEqual([
      "playbooks/b: playbook needs agent.when (or agent.offer: false)",
      "guides/g: agent.offer is true but agent.when is missing",
    ]);
  });

  test("renders triggers and templates for offered pages only", async () => {
    const index = renderDocsIndex(await collectDocsPages(root));
    expect(index).toContain(
      "- [A](https://docs.agent-swarm.dev/docs/playbooks/a). When: Someone wants A. Template: `community/a`.",
    );
    expect(index).toContain(
      "- [Playbooks](https://docs.agent-swarm.dev/docs/playbooks). Reference.",
    );
    expect(index).toContain("- [Home](https://docs.agent-swarm.dev/docs)");
  });

  test("replaceIndexBlock swaps only the marked block and rejects missing markers", () => {
    const content = `before\n${INDEX_START}\nold\n${INDEX_END}\nafter\n`;
    expect(replaceIndexBlock(content, `${INDEX_START}\nnew\n${INDEX_END}`)).toBe(
      `before\n${INDEX_START}\nnew\n${INDEX_END}\nafter\n`,
    );
    expect(() => replaceIndexBlock("no markers", "x")).toThrow();
  });
});
