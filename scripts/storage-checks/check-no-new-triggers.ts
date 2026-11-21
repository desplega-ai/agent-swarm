#!/usr/bin/env bun
/**
 * check:no-new-triggers (Postgres brief check 14, decision D9).
 *
 * The head-schema triggers were ported once, into the Postgres baseline. New
 * rules go into repository code, not into triggers. This check fails when:
 *
 * - a SQLite migration added after the base commit (src/be/migrations/*.sql
 *   that is not in the base commit's tree) contains CREATE TRIGGER, or
 * - a Postgres migration (src/be/migrations/postgres/*.sql) other than the
 *   generated NNN_baseline.sql contains CREATE TRIGGER.
 *
 * The hand-written trigger ports in src/be/migrations/postgres/parts/ are the
 * baseline's input and are not scanned. The base commit is the commit the
 * storage-engine branch started from; override it with STORAGE_BASE_COMMIT.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SQLITE_DIR = "src/be/migrations";
const POSTGRES_DIR = "src/be/migrations/postgres";
const BASE_COMMIT = process.env.STORAGE_BASE_COMMIT ?? "99d7de13a";

const CREATE_TRIGGER =
  /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i;

/** SQL text without comments, so a comment that mentions CREATE TRIGGER does not count. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export function hasCreateTrigger(sql: string): boolean {
  return CREATE_TRIGGER.test(stripSqlComments(sql));
}

function sqlFiles(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();
}

function baseFiles(): Set<string> {
  const proc = Bun.spawnSync(["git", "ls-tree", "--name-only", `${BASE_COMMIT}:${SQLITE_DIR}`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `cannot list ${SQLITE_DIR} at base commit ${BASE_COMMIT} (fetch it, or set STORAGE_BASE_COMMIT): ${proc.stderr.toString().trim()}`,
    );
  }
  return new Set(
    proc.stdout
      .toString()
      .split("\n")
      .filter((n) => n.endsWith(".sql")),
  );
}

if (import.meta.main) {
  const atBase = baseFiles();
  const offenders: string[] = [];
  const newSqlite = sqlFiles(SQLITE_DIR).filter((f) => !atBase.has(f));
  for (const file of newSqlite) {
    if (hasCreateTrigger(readFileSync(join(REPO_ROOT, SQLITE_DIR, file), "utf8"))) {
      offenders.push(`${SQLITE_DIR}/${file} (SQLite migration added after ${BASE_COMMIT})`);
    }
  }
  const postgres = sqlFiles(POSTGRES_DIR).filter((f) => !/^\d+_baseline\.sql$/.test(f));
  for (const file of postgres) {
    if (hasCreateTrigger(readFileSync(join(REPO_ROOT, POSTGRES_DIR, file), "utf8"))) {
      offenders.push(`${POSTGRES_DIR}/${file} (Postgres migration after the baseline)`);
    }
  }
  if (offenders.length > 0) {
    console.error(
      "ERROR: CREATE TRIGGER in a new migration (decision D9: put new rules in repository code):",
    );
    for (const o of offenders) console.error(`  ${o}`);
    process.exit(1);
  }
  console.log(
    `no-new-triggers: ok (${newSqlite.length} SQLite migration(s) after ${BASE_COMMIT}, ${postgres.length} Postgres migration(s) after the baseline)`,
  );
}
