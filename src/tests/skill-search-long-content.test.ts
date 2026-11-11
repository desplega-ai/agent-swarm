import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createSkill,
  deleteSkill,
  getDb,
  initDb,
  searchSkills,
  updateSkill,
} from "../be/db";

// Natural-language probes that missed on the live catalog: the obvious skill
// has a long SKILL.md body, and a shorter skill repeats the query words in
// its content. bm25 over the whole row buried the name/description hit.
const TEST_DB_PATH = `./test-skill-search-long-content-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

async function topNames(query: string): Promise<string[]> {
  return (await searchSkills(query, 10, false)).map((skill) => skill.name);
}

// A long body of words that no probe uses, like a full SKILL.md.
const longBody = (topic: string) =>
  `${topic}\n${"Each step lists its inputs, outputs and the checks to run afterwards. ".repeat(60)}`;

describe("searchSkills on long skill bodies", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);

    const fixture = [
      {
        name: "pages",
        description: "Publish hosted HTML pages with share links for outside readers.",
        content: longBody("Hosted artifacts."),
      },
      {
        name: "newsletter-sources",
        description: "Weekly AI newsletter source list and reading picks.",
        content: "Publish a short note for a page you read, then publish the page list. ".repeat(6),
      },
      {
        name: "browser-interaction",
        description: "Drive a headless browser.",
        content: "Open a page, wait for a page to load, then read a page. ".repeat(6),
      },
      {
        name: "scheduling",
        description: "Recurring jobs with cron expressions: create, pause or resume a schedule.",
        content: longBody("Cron jobs."),
      },
      {
        name: "social-content",
        description: "Draft social posts for the brand accounts.",
        content: "How do I create a post? Create a draft, then schedule a post for a slot. ".repeat(
          6,
        ),
      },
      {
        name: "code-quality",
        description: "Checks to run before you push or open a pull request, and how to review one.",
        content: longBody("Pre-push gate."),
      },
      {
        name: "customer-ops",
        description: "Operations runbook for one customer deployment.",
        content:
          "Open a pull request, ask a reviewer, review a pull request, request a fix. ".repeat(6),
      },
      // "get" is a stopword, and "aaa-get-helper" sorts first by name.
      { name: "get", description: "Fetch API resources.", content: "fetch resources" },
      { name: "aaa-get-helper", description: "Get helper instructions", content: "get content" },
      { name: "what is it", description: "Release notes digest.", content: "notes" },
      { name: "aaa-what-is-it", description: "What is it for, in short.", content: "notes" },
    ];
    for (const skill of fixture) await createSkill({ ...skill, scope: "swarm" });
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test.each([
    ["publish a page", "pages"],
    ["how do I create a schedule", "scheduling"],
    ["how do I review a pull request", "code-quality"],
  ])("%p ranks %p first over content that repeats the query words", async (query, expected) => {
    expect((await topNames(query))[0]).toBe(expected);
  });

  test("stopwords do not match every skill", async () => {
    // Every fixture body contains "a"; only skills about pages may match.
    expect(await topNames("publish a page")).not.toContain("code-quality");
  });

  test("a query of only stopwords falls back to the substring match", async () => {
    const names = await topNames("how do I");
    expect(names).toContain("social-content");
    expect(names).not.toContain("pages");
  });

  test.each([
    "get",
    "GET",
    " Get ",
  ])("an exact-name query of only stopwords (%p) ranks that skill first", async (query) => {
    expect((await searchSkills(query, 1, false)).map((skill) => skill.name)).toEqual(["get"]);
    expect((await topNames(query)).slice(0, 2)).toEqual(["get", "aaa-get-helper"]);
  });

  test("a multi-word exact name of only stopwords ranks first", async () => {
    expect((await searchSkills("What Is It", 1, false)).map((skill) => skill.name)).toEqual([
      "what is it",
    ]);
  });

  test("keeps the name/description index in sync on update and delete", async () => {
    const skill = await createSkill({
      name: "meta-sync-probe",
      description: "Starts with gammaword.",
      content: "",
      scope: "swarm",
    });
    const metaRows = (term: string) =>
      getDb()
        .query<{ skill_id: string }, [string]>(
          "SELECT skill_id FROM skills_meta_fts WHERE skills_meta_fts MATCH ?",
        )
        .all(`"${term}"`)
        .map((row) => row.skill_id);
    expect(metaRows("gammaword")).toEqual([skill.id]);

    await updateSkill(skill.id, { description: "Now about deltaword." });
    expect(metaRows("gammaword")).toEqual([]);
    expect(metaRows("deltaword")).toEqual([skill.id]);

    await deleteSkill(skill.id);
    expect(metaRows("deltaword")).toEqual([]);
  });

  test("migrated schema carries the name/description sync triggers", () => {
    const triggers = getDb()
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'skills' AND name LIKE 'skills_meta_fts_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(triggers).toEqual([
      "skills_meta_fts_delete",
      "skills_meta_fts_insert",
      "skills_meta_fts_update",
    ]);
  });
});

test("migration 241 backfills skills that existed before it ran", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(await Bun.file("src/be/migrations/019_skills.sql").text());
    db.run(
      "INSERT INTO skills (id, name, description, content, type, scope, createdAt, lastUpdatedAt) VALUES ('s1', 'legacy-skill', 'Old description', 'old body', 'remote', 'swarm', '2026-01-01', '2026-01-01')",
    );
    const migration = await Bun.file("src/be/migrations/241_skills_meta_fts.sql").text();
    db.exec(migration);

    const match = (term: string) =>
      db
        .query<{ skill_id: string }, [string]>(
          "SELECT skill_id FROM skills_meta_fts WHERE skills_meta_fts MATCH ?",
        )
        .all(term)
        .map((row) => row.skill_id);
    expect(match('"description"')).toEqual(["s1"]);
    // Content is not indexed here.
    expect(match('"body"')).toEqual([]);

    // Re-running the migration does not duplicate backfilled rows.
    db.exec(migration);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM skills_meta_fts").get()?.n).toBe(
      1,
    );
  } finally {
    db.close();
  }
});
