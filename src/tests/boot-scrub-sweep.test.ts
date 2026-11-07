import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  BOOT_SCRUB_TARGETS,
  bootScrubCursorKey,
  bootScrubDoneKey,
  bootScrubSkippedKey,
  nextRestRatio,
  runBootScrubSweep,
} from "../be/boot-scrub-sweep";
import { closeDb, getDb, getDbClient, initDb, isSqliteVecAvailable } from "../be/db";
import { getMemoryStore } from "../be/memory";
import { registerStoredSecret } from "../be/secret-registry";
import { contentSha256 } from "../commands/profile-sync";
import {
  refreshSecretScrubberCache,
  registerVolatileSecret,
  SCRUBBER_RULES_VERSION,
  scrubberRulesFingerprint,
  scrubSecrets,
  unregisterVolatileSecret,
} from "../utils/secret-scrubber";
import { buildNegatives, buildPositives } from "./fixtures/secret-corpus";
import { randomToken, type SyntheticSecret, syntheticSecret } from "./synthetic-secret-helpers";

const TEST_DB_PATH = "./test-boot-scrub-sweep.sqlite";
const AGENT_ID = "5c2b0000-0000-4000-8000-000000000001";
// Distinctive non-secret words: FTS must still find the row by them after redaction.
const MARKER_WORD = "quokkazebra";

let known: SyntheticSecret;
let envName: string;
let envValue: string;
let password: string;

/** Text carrying all three secret forms: known value, env value and a `*_PASSWORD=` assignment. */
function secretText(label: string): string {
  return `${label} ${MARKER_WORD} token=${known.value} env=${envValue} X_DEMO_PASSWORD=${password} end`;
}

function expectRedacted(value: string | null | undefined, where: string): void {
  expect(value, where).toBeString();
  for (const secret of [known.value, envValue, password]) {
    expect(value!.includes(secret), `${where} still holds a secret`).toBe(false);
  }
  expect(value!, where).toContain("[REDACTED:");
}

async function writeAudit(): Promise<{ tbl: string; id: string }[]> {
  return getDbClient().query<{ tbl: string; id: string }>("SELECT tbl, id FROM scrub_write_audit");
}

async function ftsHits(term: string): Promise<string[]> {
  const rows = await getDbClient().query<{ memory_id: string }>(
    "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?",
    [`"${term}"`],
  );
  return rows.map((r) => r.memory_id);
}

const ids = {
  log: crypto.randomUUID(),
  logControl: crypto.randomUUID(),
  task: crypto.randomUUID(),
  taskControl: crypto.randomUUID(),
  event: crypto.randomUUID(),
  run: crypto.randomUUID(),
  step: crypto.randomUUID(),
  memory: "",
};

describe("boot retro-sweep", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    // workflow_run_steps.runId references workflow_runs; the sweep never
    // touches FKs, so seed the step without building a whole workflow.
    getDb().run("PRAGMA foreign_keys = OFF");

    known = syntheticSecret("sweep");
    envName = "X_DEMO_SWEEP_API_KEY";
    envValue = randomToken(32);
    process.env[envName] = envValue;
    refreshSecretScrubberCache();
    password = randomToken(24);

    const db = getDbClient();
    // Every UPDATE on a swept table lands here: proves untouched rows saw no write.
    await db.run("CREATE TABLE scrub_write_audit (tbl TEXT NOT NULL, id TEXT NOT NULL)");
    for (const { table, idColumn } of BOOT_SCRUB_TARGETS) {
      await db.run(
        `CREATE TRIGGER audit_${table} AFTER UPDATE ON ${table}
         BEGIN INSERT INTO scrub_write_audit (tbl, id) VALUES ('${table}', NEW.${idColumn ?? "id"}); END`,
      );
    }

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO session_logs (id, sessionId, iteration, content, lineNumber, createdAt)
       VALUES (?, 's1', 1, ?, 1, ?), (?, 's1', 1, ?, 2, ?)`,
      [ids.log, secretText("log"), now, ids.logControl, "plain log line, nothing to hide", now],
    );
    await db.run(
      `INSERT INTO agent_tasks (id, task, output, failureReason, progress, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, 'control task', 'control output', NULL, NULL, ?, ?)`,
      [
        ids.task,
        secretText("task"),
        secretText("output"),
        secretText("failure"),
        secretText("progress"),
        now,
        now,
        ids.taskControl,
        now,
        now,
      ],
    );
    await db.run(
      `INSERT INTO events (id, category, event, source, data, createdAt)
       VALUES (?, 'test', 'test.event', 'test', ?, ?)`,
      [ids.event, JSON.stringify({ note: secretText("event"), nested: { n: 1 } }), now],
    );
    await db.run(
      `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, input, output, error, diagnostics)
       VALUES (?, ?, 'n1', 'agent-task', ?, ?, ?, ?)`,
      [
        ids.step,
        ids.run,
        JSON.stringify({ prompt: secretText("input") }),
        JSON.stringify({ result: secretText("step-output") }),
        secretText("error"),
        JSON.stringify({ trace: secretText("diagnostics") }),
      ],
    );

    const store = getMemoryStore();
    const legacy = {
      name: `note ${known.value}`,
      content: secretText("memory"),
      summary: secretText("summary"),
    };
    const memory = await store.store({
      agentId: AGENT_ID,
      scope: "agent",
      source: "manual",
      ...legacy,
    });
    ids.memory = memory.id;
    // store() now scrubs at write; put the raw text back so the row looks like
    // one written before that, which is what the sweep exists for.
    await db.run(
      "UPDATE agent_memory SET name = ?, content = ?, summary = ?, contentHash = ? WHERE id = ?",
      [legacy.name, legacy.content, legacy.summary, contentSha256(legacy.content), memory.id],
    );
    await db.run(
      "UPDATE agent_memory_version SET content = ?, contentHash = ? WHERE memory_id = ?",
      [legacy.content, contentSha256(legacy.content), memory.id],
    );
    await db.run("DELETE FROM memory_fts WHERE memory_id = ?", [memory.id]);
    await db.run("INSERT INTO memory_fts(memory_id, name, content) VALUES (?, ?, ?)", [
      memory.id,
      legacy.name,
      legacy.content,
    ]);
    const embedding = new Float32Array(512);
    embedding[0] = 1;
    await store.updateEmbedding(memory.id, embedding, "test");
  });

  // The test preload clears volatile secrets after every test.
  beforeEach(() => registerVolatileSecret(known.value, known.name));

  afterAll(async () => {
    delete process.env[envName];
    known.cleanup();
    refreshSecretScrubberCache();
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("redacts every target column, keeps context, JSON and FTS, drops the stale vector", async () => {
    const db = getDbClient();
    // Positive controls: the secret is really in the index and the vector exists.
    expect(await ftsHits(password)).toContain(ids.memory);
    const before = await db.get<{ embedding: Uint8Array | null }>(
      "SELECT embedding FROM agent_memory WHERE id = ?",
      [ids.memory],
    );
    expect(before?.embedding).not.toBeNull();
    if (isSqliteVecAvailable()) {
      expect(
        await db.get("SELECT memory_id FROM memory_vec WHERE memory_id = ?", [ids.memory]),
      ).not.toBeNull();
    }

    const stats = await runBootScrubSweep({ version: SCRUBBER_RULES_VERSION, reembed: false });
    expect(stats).not.toBeNull();
    const byTable = Object.fromEntries(stats!.map((s) => [s.table, s]));
    expect(byTable.session_logs!.changed).toBe(1);
    expect(byTable.agent_tasks!.changed).toBe(1);
    expect(byTable.agent_memory!.changed).toBe(1);
    expect(byTable.agent_memory_version!.changed).toBe(1);
    expect(byTable.events!.changed).toBe(1);
    expect(byTable.workflow_run_steps!.changed).toBe(1);

    const log = await db.get<{ content: string }>("SELECT content FROM session_logs WHERE id = ?", [
      ids.log,
    ]);
    expectRedacted(log?.content, "session_logs.content");
    expect(log!.content).toContain(MARKER_WORD);

    const task = await db.get<Record<string, string>>(
      "SELECT task, output, failureReason, progress FROM agent_tasks WHERE id = ?",
      [ids.task],
    );
    for (const col of ["task", "output", "failureReason", "progress"]) {
      expectRedacted(task?.[col], `agent_tasks.${col}`);
    }

    const mem = await db.get<{
      name: string;
      content: string;
      summary: string;
      contentHash: string;
      embedding: Uint8Array | null;
    }>("SELECT name, content, summary, contentHash, embedding FROM agent_memory WHERE id = ?", [
      ids.memory,
    ]);
    expectRedacted(mem?.name, "agent_memory.name");
    expectRedacted(mem?.content, "agent_memory.content");
    expectRedacted(mem?.summary, "agent_memory.summary");
    expect(mem!.contentHash).toBe(contentSha256(mem!.content));
    expect(mem!.embedding).toBeNull();
    if (isSqliteVecAvailable()) {
      expect(
        await db.get("SELECT memory_id FROM memory_vec WHERE memory_id = ?", [ids.memory]),
      ).toBeNull();
    }
    // FTS was rewritten from the scrubbed text, not left stale.
    expect(await ftsHits(MARKER_WORD)).toContain(ids.memory);
    expect(await ftsHits(password)).not.toContain(ids.memory);

    const version = await db.get<{ content: string; contentHash: string }>(
      "SELECT content, contentHash FROM agent_memory_version WHERE memory_id = ?",
      [ids.memory],
    );
    expectRedacted(version?.content, "agent_memory_version.content");
    expect(version!.contentHash).toBe(contentSha256(version!.content));

    const event = await db.get<{ data: string }>("SELECT data FROM events WHERE id = ?", [
      ids.event,
    ]);
    expectRedacted(event?.data, "events.data");
    const parsed = JSON.parse(event!.data) as { note: string; nested: { n: number } };
    expect(parsed.nested.n).toBe(1);
    expect(parsed.note).toContain(MARKER_WORD);

    const step = await db.get<Record<string, string>>(
      "SELECT input, output, error, diagnostics FROM workflow_run_steps WHERE id = ?",
      [ids.step],
    );
    for (const col of ["input", "output", "error", "diagnostics"]) {
      expectRedacted(step?.[col], `workflow_run_steps.${col}`);
    }
    for (const col of ["input", "output", "diagnostics"]) {
      expect(() => JSON.parse(step![col]!)).not.toThrow();
    }
  });

  test("control rows without a secret see no write", async () => {
    const audit = await writeAudit();
    // Positive control: the trigger fired for the rows that held a secret.
    expect(audit).toContainEqual({ tbl: "session_logs", id: ids.log });
    expect(audit).toContainEqual({ tbl: "agent_tasks", id: ids.task });
    // The controls were never written.
    expect(audit.map((a) => a.id)).not.toContain(ids.logControl);
    expect(audit.map((a) => a.id)).not.toContain(ids.taskControl);
    const control = await getDbClient().get<{ content: string }>(
      "SELECT content FROM session_logs WHERE id = ?",
      [ids.logControl],
    );
    expect(control?.content).toBe("plain log line, nothing to hide");
  });

  test("marks the version done and is a no-op on rerun; a new version runs again", async () => {
    const db = getDbClient();
    expect(
      await db.get("SELECT key FROM seed_state WHERE kind = 'maintenance' AND key = ?", [
        bootScrubDoneKey(SCRUBBER_RULES_VERSION),
      ]),
    ).not.toBeNull();
    const cursors = await db.query("SELECT key FROM seed_state WHERE key LIKE 'boot-scrub-v%:%'");
    expect(cursors).toHaveLength(0);

    const auditBefore = (await writeAudit()).length;
    expect(await runBootScrubSweep({ version: SCRUBBER_RULES_VERSION, reembed: false })).toBeNull();

    const bumped = SCRUBBER_RULES_VERSION + 100;
    const stats = await runBootScrubSweep({ version: bumped, reembed: false });
    expect(stats).not.toBeNull();
    expect(stats!.every((s) => s.changed === 0)).toBe(true);
    expect(stats!.find((s) => s.table === "session_logs")!.scanned).toBeGreaterThanOrEqual(2);
    expect((await writeAudit()).length).toBe(auditBefore);
    expect(
      await db.get("SELECT key FROM seed_state WHERE kind = 'maintenance' AND key = ?", [
        bootScrubDoneKey(bumped),
      ]),
    ).not.toBeNull();
  });

  test("an interrupted run resumes from the cursor without rescanning batch 1", async () => {
    const db = getDbClient();
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      await db.run(
        `INSERT INTO session_logs (id, sessionId, iteration, content, lineNumber, createdAt)
         VALUES (?, 's2', 1, ?, ?, ?)`,
        [crypto.randomUUID(), secretText(`resume-${i}`), 10 + i, now],
      );
    }
    const version = SCRUBBER_RULES_VERSION + 200;
    let firstBatch: string[] = [];
    await expect(
      runBootScrubSweep({
        version,
        batchSize: 2,
        reembed: false,
        afterBatch: ({ table, ids: batchIds }) => {
          if (table !== "session_logs") return;
          firstBatch = batchIds;
          throw new Error("interrupted after batch 1");
        },
      }),
    ).rejects.toThrow("interrupted after batch 1");
    expect(firstBatch).toHaveLength(2);

    const cursor = await db.get<{ seededHash: string }>(
      "SELECT seededHash FROM seed_state WHERE kind = 'maintenance' AND key = ?",
      [bootScrubCursorKey(version, "session_logs")],
    );
    expect(cursor?.seededHash).toBe(firstBatch[1]);
    expect(
      await db.get("SELECT key FROM seed_state WHERE key = ?", [bootScrubDoneKey(version)]),
    ).toBeNull();

    const resumed: string[] = [];
    const stats = await runBootScrubSweep({
      version,
      batchSize: 2,
      reembed: false,
      afterBatch: ({ table, ids: batchIds }) => {
        if (table === "session_logs") resumed.push(...batchIds);
      },
    });
    expect(resumed.length).toBeGreaterThan(0);
    for (const id of firstBatch) expect(resumed).not.toContain(id);
    const total = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_logs");
    expect(stats!.find((s) => s.table === "session_logs")!.scanned).toBe(total!.n - 2);

    // Batch 1 was committed before the interrupt, the rest by the resumed run.
    const remaining = await db.query<{ content: string }>(
      "SELECT content FROM session_logs WHERE sessionId = 's2'",
    );
    for (const row of remaining) expectRedacted(row.content, "resumed session_logs.content");
  });

  test("skips a row whose scrub would break valid JSON", async () => {
    const db = getDbClient();
    const id = crypto.randomUUID();
    const data = JSON.stringify({ msg: "BREAKJSON here" });
    await db.run(
      `INSERT INTO events (id, category, event, source, data, createdAt)
       VALUES (?, 'test', 'test.event', 'test', ?, ?)`,
      [id, data, new Date().toISOString()],
    );
    // Force a scrub result that is not valid JSON (an unbalanced quote).
    const stats = await runBootScrubSweep({
      version: SCRUBBER_RULES_VERSION + 300,
      reembed: false,
      scrub: (text) => text.replace("BREAKJSON", '"'),
    });
    const events = stats!.find((s) => s.table === "events")!;
    expect(events.skippedInvalidJson).toBe(1);
    expect(events.changed).toBe(0);
    const row = await db.get<{ data: string }>("SELECT data FROM events WHERE id = ?", [id]);
    expect(row?.data).toBe(data);
  });
});

describe("boot retro-sweep upgrade from v8", () => {
  beforeAll(() => initDb(":memory:"));
  afterAll(() => closeDb());

  test("the default version re-scrubs a padded credential echo once after a completed v8 sweep", async () => {
    const db = getDbClient();
    const id = crypto.randomUUID();
    const token = randomToken(32);
    const name = "SYNTHETIC_PADDED_UPGRADE_SECRET";
    const original = `credential echo: ${token}`;
    await db.run(
      `INSERT INTO seed_state (kind, key, seededHash, seededAt)
       VALUES ('maintenance', 'boot-scrub-v8', 'done', datetime('now'))`,
    );
    await db.run(
      `INSERT INTO session_logs (id, sessionId, iteration, content, lineNumber, createdAt)
       VALUES (?, 'upgrade-v8', 1, ?, 1, datetime('now'))`,
      [id, original],
    );

    // Registration now also covers the trimmed echo that the old rules missed.
    registerStoredSecret(` \t${token}\n`, name);
    try {
      expect(await runBootScrubSweep({ version: 8, reembed: false })).toBeNull();
      expect(
        (await db.get<{ content: string }>("SELECT content FROM session_logs WHERE id = ?", [id]))
          ?.content,
      ).toBe(original);

      const stats = await runBootScrubSweep({ reembed: false });
      expect(stats?.find((s) => s.table === "session_logs")?.changed).toBe(1);
      expect(
        (await db.get<{ content: string }>("SELECT content FROM session_logs WHERE id = ?", [id]))
          ?.content,
      ).toBe(`credential echo: [REDACTED:${name}]`);
      expect(
        await db.get("SELECT key FROM seed_state WHERE kind = 'maintenance' AND key = ?", [
          bootScrubDoneKey(SCRUBBER_RULES_VERSION),
        ]),
      ).not.toBeNull();
      expect(await runBootScrubSweep({ reembed: false })).toBeNull();
    } finally {
      unregisterVolatileSecret(name);
    }
  });
});

describe("boot retro-sweep equivalence", () => {
  beforeAll(() => initDb(":memory:"));
  afterAll(() => closeDb());

  test("the default (selective) sweep leaves every corpus row as a full `scrubSecrets` does", async () => {
    const db = getDbClient();
    const texts = [
      ...buildPositives().map((p) => p.text),
      ...buildNegatives(),
      "ran 12 tests in 3.4s, all passed",
      "",
    ];
    const rows = texts.map((content, i) => ({ id: crypto.randomUUID(), content, line: i }));
    for (const r of rows) {
      await db.run(
        `INSERT INTO session_logs (id, sessionId, iteration, content, lineNumber, createdAt)
         VALUES (?, 'equivalence', 1, ?, ?, datetime('now'))`,
        [r.id, r.content, r.line],
      );
    }

    const stats = await runBootScrubSweep({ version: 7001, reembed: false });
    expect(stats?.find((s) => s.table === "session_logs")?.scanned).toBe(rows.length);

    let redacted = 0;
    for (const r of rows) {
      const after = (
        await db.get<{ content: string }>("SELECT content FROM session_logs WHERE id = ?", [r.id])
      )?.content;
      expect(after, r.content.slice(0, 60)).toBe(scrubSecrets(r.content));
      if (after !== r.content) redacted++;
    }
    // Positive control: the corpus does hold secrets, so the comparison is not vacuous.
    expect(redacted).toBeGreaterThan(buildPositives().length / 2);
  });
});

describe("boot retro-sweep forward-only mode", () => {
  const savedMode = process.env.BOOT_SCRUB_MODE;
  let secret: string;
  const rowIds: string[] = [];

  beforeAll(() => initDb(":memory:"));
  afterAll(() => {
    if (savedMode === undefined) delete process.env.BOOT_SCRUB_MODE;
    else process.env.BOOT_SCRUB_MODE = savedMode;
    closeDb();
  });

  async function content(id: string): Promise<string | undefined> {
    return (
      await getDbClient().get<{ content: string }>(
        "SELECT content FROM session_logs WHERE id = ?",
        [id],
      )
    )?.content;
  }

  async function seedState(key: string) {
    return getDbClient().get<{ seededHash: string }>(
      "SELECT seededHash FROM seed_state WHERE kind = 'maintenance' AND key = ?",
      [key],
    );
  }

  test("touches no historical row, records the skipped version, and a later backfill sweeps it", async () => {
    const db = getDbClient();
    secret = `AKIA${randomToken(16)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "A")
      .padEnd(16, "A")
      .slice(0, 16)}`;
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      rowIds.push(id);
      await db.run(
        `INSERT INTO session_logs (id, sessionId, iteration, content, lineNumber, createdAt)
         VALUES (?, 'fwd', 1, ?, ?, datetime('now'))`,
        [id, `row ${i} key ${secret} end`, i],
      );
    }
    await db.run("CREATE TABLE fwd_audit (id TEXT NOT NULL)");
    await db.run(
      "CREATE TRIGGER fwd_audit_logs AFTER UPDATE ON session_logs BEGIN INSERT INTO fwd_audit VALUES (NEW.id); END",
    );

    process.env.BOOT_SCRUB_MODE = "forward-only";
    expect(await runBootScrubSweep({ version: 7101, reembed: false })).toBeNull();
    expect(await runBootScrubSweep({ version: 7102, reembed: false })).toBeNull();

    // Nothing read or written: rows intact, no cursor, no done marker.
    for (const id of rowIds) expect(await content(id)).toContain(secret);
    expect(await db.query("SELECT id FROM fwd_audit")).toEqual([]);
    expect(await seedState(bootScrubCursorKey(7102, "session_logs"))).toBeNull();
    expect(await seedState(bootScrubDoneKey(7102))).toBeNull();
    // Both versions recorded, with the fingerprint of the rule tables.
    const fingerprint = scrubberRulesFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect((await seedState(bootScrubSkippedKey(7101)))?.seededHash).toBe(fingerprint);
    expect((await seedState(bootScrubSkippedKey(7102)))?.seededHash).toBe(fingerprint);

    // Back on backfill: the current version sweeps every row and clears the records it covers.
    process.env.BOOT_SCRUB_MODE = "backfill";
    const stats = await runBootScrubSweep({ version: 7102, reembed: false });
    expect(stats?.find((t) => t.table === "session_logs")?.changed).toBe(3);
    for (const id of rowIds) {
      expect(await content(id)).not.toContain(secret);
      expect(await content(id)).toContain("[REDACTED:");
    }
    expect(await seedState(bootScrubDoneKey(7102))).not.toBeNull();
    expect(await seedState(bootScrubSkippedKey(7101))).toBeNull();
    expect(await seedState(bootScrubSkippedKey(7102))).toBeNull();
  });

  test("a skipped record newer than the swept version stays", async () => {
    process.env.BOOT_SCRUB_MODE = "forward-only";
    await runBootScrubSweep({ version: 7203, reembed: false });
    process.env.BOOT_SCRUB_MODE = "backfill";
    await runBootScrubSweep({ version: 7202, reembed: false });
    expect(await seedState(bootScrubSkippedKey(7203))).not.toBeNull();
  });

  test("switching to forward-only halts a running sweep, and backfill resumes from its cursor", async () => {
    const db = getDbClient();
    const version = 7301;
    const batches: string[][] = [];
    process.env.BOOT_SCRUB_MODE = "backfill";
    const first = await runBootScrubSweep({
      version,
      batchSize: 1,
      reembed: false,
      afterBatch: ({ table, ids }) => {
        if (table !== "session_logs") return;
        batches.push(ids);
        if (batches.length === 1) process.env.BOOT_SCRUB_MODE = "forward-only";
      },
    });
    // One batch ran, then the sweep stopped without marking the version done.
    expect(first?.find((t) => t.table === "session_logs")?.scanned).toBe(1);
    expect(first?.length).toBe(1);
    expect(await seedState(bootScrubDoneKey(version))).toBeNull();
    expect(await seedState(bootScrubSkippedKey(version))).not.toBeNull();
    expect(await seedState(bootScrubCursorKey(version, "session_logs"))).not.toBeNull();

    process.env.BOOT_SCRUB_MODE = "backfill";
    const resumed = await runBootScrubSweep({ version, batchSize: 1, reembed: false });
    // Rows 2.. only: the first batch is not scanned again.
    expect(resumed?.find((t) => t.table === "session_logs")?.scanned).toBe(
      (await db.get<{ n: number }>("SELECT count(*) AS n FROM session_logs"))!.n - 1,
    );
    expect(await seedState(bootScrubDoneKey(version))).not.toBeNull();
    expect(await seedState(bootScrubSkippedKey(version))).toBeNull();
  });
});

describe("boot retro-sweep pacing", () => {
  test("rests longer while the loop lags, shorter while it idles, and holds in between", () => {
    expect(nextRestRatio(1, 20)).toBe(2);
    expect(nextRestRatio(2, 20)).toBe(4);
    expect(nextRestRatio(12, 20)).toBe(16);
    expect(nextRestRatio(16, 500)).toBe(16);
    expect(nextRestRatio(1, 0)).toBeLessThan(1);
    expect(nextRestRatio(0.25, 0)).toBe(0.25);
    expect(nextRestRatio(3, 5)).toBe(3);
  });
});
