#!/usr/bin/env bun
/**
 * Every TEXT column in the schema must be classified in `.text-columns.json`:
 *
 * - `"scrubbed"`: every writer passes the value through `scrubSecrets` (or
 *   takes a `ScrubbedText`), so a recognisable secret never lands at rest.
 * - `{ "exempt": "<reason>" }`: the column cannot hold free text (ids, enums,
 *   timestamps, hashes) or must round-trip byte-exact (ciphertext, credential
 *   stores, KV values).
 * - `{ "pending": "<tracking note>" }`: free text whose writers are not yet
 *   scrubbed. The note names the batch that will flip it.
 *
 * A new TEXT column with no entry fails the check, so a new sink cannot land
 * without someone deciding how secrets are kept out of it. A stale entry (the
 * table or column no longer exists) also fails.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/be/migrations/runner";

export const TEXT_COLUMNS_PATH = ".text-columns.json";

export type TextColumnClass = "scrubbed" | { exempt: string } | { pending: string };
export type TextColumnClassification = Record<string, Record<string, TextColumnClass>>;

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** SQLite type-affinity rule 2: a declared type containing CHAR, CLOB or TEXT. */
function hasTextAffinity(declaredType: string): boolean {
  return /CHAR|CLOB|TEXT/i.test(declaredType);
}

function isValidClass(value: unknown): value is TextColumnClass {
  if (value === "scrubbed") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== 1) return false;
  const [kind, reason] = entries[0] as [string, unknown];
  return (
    (kind === "exempt" || kind === "pending") &&
    typeof reason === "string" &&
    reason.trim().length > 0
  );
}

/** Lists `table.column` for every TEXT-affinity column of every real table. */
export function listTextColumns(db: Database): string[] {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  const columns: string[] = [];
  for (const table of tables) {
    const info = db
      .query<{ name: string; type: string }, []>(`PRAGMA table_info(${quoteIdent(table)})`)
      .all();
    for (const column of info) {
      if (hasTextAffinity(column.type)) columns.push(`${table}.${column.name}`);
    }
  }
  return columns;
}

/** Returns one human-readable violation per problem; empty means the check passes. */
export function checkTextColumns(db: Database, classification: TextColumnClassification): string[] {
  const violations: string[] = [];
  const actual = new Set(listTextColumns(db));
  const declared = new Set<string>();

  for (const [table, columns] of Object.entries(classification)) {
    for (const [column, value] of Object.entries(columns)) {
      const id = `${table}.${column}`;
      declared.add(id);
      if (!isValidClass(value)) {
        violations.push(
          `${id}: invalid entry ${JSON.stringify(value)} (use "scrubbed", {"exempt": "<reason>"} or {"pending": "<note>"})`,
        );
      }
      if (!actual.has(id)) violations.push(`${id}: stale entry, no such TEXT column`);
    }
  }
  for (const id of actual) {
    if (!declared.has(id)) violations.push(`${id}: unclassified TEXT column`);
  }
  return violations;
}

if (import.meta.main) {
  const tempDir = mkdtempSync(join(tmpdir(), "agent-swarm-text-columns-"));
  try {
    const db = new Database(join(tempDir, "text-columns.sqlite"), { create: true });
    const originalLog = console.log;
    const originalDebug = console.debug;
    console.log = () => {};
    console.debug = () => {};
    try {
      runMigrations(db);
    } finally {
      console.log = originalLog;
      console.debug = originalDebug;
    }

    const classification = (await Bun.file(TEXT_COLUMNS_PATH).json()) as TextColumnClassification;
    const violations = checkTextColumns(db, classification);
    if (violations.length > 0) {
      console.error(`TEXT-column classification check failed (${TEXT_COLUMNS_PATH}):`);
      for (const violation of violations) console.error(`  - ${violation}`);
      console.error("");
      console.error(
        'Classify each new TEXT column as "scrubbed" (every writer scrubs it), {"exempt": "<reason>"} or {"pending": "<tracking note>"}. See runbooks/secret-scrubbing.md.',
      );
      process.exit(1);
    }

    const counts = { scrubbed: 0, exempt: 0, pending: 0 };
    for (const columns of Object.values(classification)) {
      for (const value of Object.values(columns)) {
        counts[value === "scrubbed" ? "scrubbed" : "exempt" in value ? "exempt" : "pending"]++;
      }
    }
    console.log(
      `TEXT-column check passed: ${counts.scrubbed} scrubbed, ${counts.exempt} exempt, ${counts.pending} pending.`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
