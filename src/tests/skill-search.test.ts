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

const TEST_DB_PATH = `./test-skill-search-${process.pid}.sqlite`;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

async function topNames(query: string, limit?: number): Promise<string[]> {
  return (await searchSkills(query, limit)).map((skill) => skill.name);
}

describe("searchSkills", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);

    const fixture = [
      {
        name: "pr-review-fix-loop",
        description: "Run review fix rounds on a pull request until CI is green.",
        content: "Reply to each review thread, push the fix, wait for checks.",
      },
      {
        name: "code-quality",
        description: "Pre-push checklist for any code change.",
        content: "Run lint, typecheck and tests, then read the diff as a reviewer would.",
      },
      {
        name: "swarm-scripts",
        description: "Author and run reusable TypeScript in the swarm.",
        content: "script-upsert, script-run, credential bindings and secrets stay server-side.",
      },
      {
        name: "agent-fs",
        description: "Shared drive for documents between agents and people.",
        content: "Upload markdown and create share links for outside readers.",
      },
      {
        name: "scheduling",
        description: "Create recurring jobs with cron expressions.",
        content: "Pick a timezone, set the next run, pause or resume a schedule.",
      },
      {
        name: "schedule-audit",
        description: "Audit scheduling drift and missed schedules.",
        content: "Compare each schedule's last run with its cron.",
      },
      {
        name: "memory",
        description: "Store, search and rate learnings from past sessions.",
        content: "Use memory-store for a fix that will come back.",
      },
      {
        name: "call-time-trap-placement",
        description: "Decide where operational rules belong.",
        content: "Use toolsMd and claudeMd to document the delivery surface.",
      },
      {
        name: "content-search-example",
        description: "A skill with a content-only term.",
        content: "This body contains the needle-token.",
      },
    ];
    for (const skill of fixture) await createSkill({ ...skill, scope: "swarm" });
    await createSkill({
      name: "disabled-cron-helper",
      description: "Recurring cron jobs, the old way.",
      content: "cron cron cron schedule",
      scope: "swarm",
      isEnabled: false,
    });
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("ranks a name match first", async () => {
    expect((await topNames("scheduling"))[0]).toBe("scheduling");
    expect((await topNames("code quality"))[0]).toBe("code-quality");
  });

  test("ranks a description-only match first", async () => {
    expect((await topNames("recurring cron jobs"))[0]).toBe("scheduling");
  });

  test("ranks a content-only match first", async () => {
    expect((await topNames("credential bindings"))[0]).toBe("swarm-scripts");
    expect(await topNames("needle-token")).toEqual(["content-search-example"]);
  });

  test("ranks natural-language queries by relevance instead of requiring every word", async () => {
    expect((await topNames("how do I review a pull request"))[0]).toBe("pr-review-fix-loop");
    expect((await topNames("where to share a document with people"))[0]).toBe("agent-fs");
  });

  test("a query equal to a skill name ranks that skill first", async () => {
    // On bm25 alone schedule-audit outscores scheduling for this query: its
    // name and description both stem to "schedul". The exact-name boost wins.
    expect((await topNames("Scheduling")).slice(0, 2)).toEqual(["scheduling", "schedule-audit"]);
    expect((await topNames("MEMORY"))[0]).toBe("memory");
    expect((await topNames("call-time-trap-placement"))[0]).toBe("call-time-trap-placement");
  });

  test("quotes FTS5 syntax in user text instead of executing it", async () => {
    for (const query of [
      '"',
      "*",
      "NEAR",
      "-",
      'cron" OR "x',
      "cron NEAR/2 jobs",
      "-cron",
      "name:cron",
      "cron*",
    ]) {
      await expect(searchSkills(query)).resolves.toBeArray();
    }
    expect((await topNames('timezone" OR "x'))[0]).toBe("scheduling");
    expect((await topNames("-timezone"))[0]).toBe("scheduling");
    // As a column filter, name:timezone would match nothing: "timezone" is
    // only in the scheduling skill's content.
    expect((await topNames("name:timezone"))[0]).toBe("scheduling");
  });

  test("excludes disabled skills", async () => {
    expect(await topNames("cron")).not.toContain("disabled-cron-helper");
    expect(await topNames("disabled-cron-helper")).not.toContain("disabled-cron-helper");
  });

  test("respects the limit and the includeContent flag", async () => {
    expect(await topNames("the", 2)).toHaveLength(2);
    const slim = await searchSkills("scheduling", 5, false);
    expect(slim[0]?.name).toBe("scheduling");
    expect(slim[0]?.content).toBe("");
  });

  test("keeps the substring fallback for partial words", async () => {
    expect(await topNames("needle-tok")).toEqual(["content-search-example"]);
  });

  test("keeps the index in sync on update and delete", async () => {
    const skill = await createSkill({
      name: "sync-probe",
      description: "Starts with alphaword.",
      content: "",
      scope: "swarm",
    });
    expect(await topNames("alphaword")).toEqual(["sync-probe"]);

    await updateSkill(skill.id, { description: "Now about betaword." });
    expect(await topNames("betaword")).toEqual(["sync-probe"]);
    expect(await topNames("alphaword")).toEqual([]);

    await deleteSkill(skill.id);
    expect(await topNames("betaword")).toEqual([]);
    const ftsRows = getDb()
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM skills_fts WHERE skill_id = ?")
      .get(skill.id);
    expect(ftsRows?.n).toBe(0);
  });

  test("migrated schema carries the sync triggers", () => {
    const triggers = getDb()
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'skills' AND name LIKE 'skills_fts_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(triggers).toEqual(["skills_fts_delete", "skills_fts_insert", "skills_fts_update"]);
  });
});

test("migration 239 backfills skills that existed before it ran", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(await Bun.file("src/be/migrations/019_skills.sql").text());
    db.run(
      "INSERT INTO skills (id, name, description, content, type, scope, createdAt, lastUpdatedAt) VALUES ('s1', 'legacy-skill', 'Old description', 'old body', 'remote', 'swarm', '2026-01-01', '2026-01-01')",
    );
    db.exec(await Bun.file("src/be/migrations/239_skills_fts.sql").text());

    const rows = db
      .query<{ skill_id: string }, [string]>(
        "SELECT skill_id FROM skills_fts WHERE skills_fts MATCH ?",
      )
      .all('"body"');
    expect(rows.map((row) => row.skill_id)).toEqual(["s1"]);

    // Re-running the migration does not duplicate backfilled rows.
    db.exec(await Bun.file("src/be/migrations/239_skills_fts.sql").text());
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM skills_fts").get()?.n).toBe(1);
  } finally {
    db.close();
  }
});
