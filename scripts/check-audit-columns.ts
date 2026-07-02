#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../apps/swarm/src/be/migrations/runner";

const REQUIRED_AUDIT_COLUMNS = ["created_by", "updated_by"] as const;
const WHITELIST_PATH = ".non-audit-tables";

type SqliteTableRow = {
  name: string;
};

type PragmaTableInfoRow = {
  name: string;
};

async function loadWhitelist(): Promise<Set<string>> {
  const contents = await Bun.file(WHITELIST_PATH).text();
  const tables = contents
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter((line) => line.length > 0);
  return new Set(tables);
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const tempDir = mkdtempSync(join(tmpdir(), "agent-swarm-audit-columns-"));
const dbPath = join(tempDir, "audit-columns.sqlite");

try {
  const db = new Database(dbPath, { create: true });
  const originalDebug = console.debug;
  console.debug = () => {};
  try {
    runMigrations(db);
  } finally {
    console.debug = originalDebug;
  }

  const whitelist = await loadWhitelist();
  const rows = db
    .query<SqliteTableRow, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const tables = rows.map((row) => row.name);
  const tableSet = new Set(tables);
  const missingWhitelistEntries = [...whitelist].filter((table) => !tableSet.has(table));
  if (missingWhitelistEntries.length > 0) {
    console.error("Audit-column whitelist references tables that do not exist:");
    for (const table of missingWhitelistEntries) {
      console.error(`  - ${table}`);
    }
    process.exit(1);
  }

  const violations: string[] = [];
  for (const table of tables) {
    if (whitelist.has(table)) continue;
    const columnRows = db
      .query<PragmaTableInfoRow, []>(`PRAGMA table_info(${quoteIdent(table)})`)
      .all();
    const columns = new Set(columnRows.map((row) => row.name));
    const missing = REQUIRED_AUDIT_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      violations.push(`${table}: missing ${missing.join(", ")}`);
    }
  }

  if (violations.length > 0) {
    console.error("Tables missing required audit columns:");
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    console.error("");
    console.error(`Add legitimate exceptions to ${WHITELIST_PATH}, one table per line.`);
    process.exit(1);
  }

  console.log(`Audit-column check passed for ${tables.length - whitelist.size} audited table(s).`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
