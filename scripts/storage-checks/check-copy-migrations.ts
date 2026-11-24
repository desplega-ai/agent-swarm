#!/usr/bin/env bun
/**
 * check:copy-migrations (the data copy of decision D11 stays correct as the chain grows).
 *
 * `agent-swarm db-copy` runs the Postgres chain on the empty target, writes the
 * SQLite rows over it, and leaves `_migrations` with every migration recorded. A
 * Postgres migration that changes rows is therefore undone by the copy, and the
 * API never runs it again. Nothing fails: the copy compares the target with the
 * source, and the source never held the change.
 *
 * This check reads each statement of each Postgres migration
 * (src/be/migrations/postgres/NNN_*.sql) and fails on a row-changing statement
 * that is none of:
 *
 * - handled by a rerun: its migration is in `reapply` of after-copy.json, so the
 *   copy runs it again after it wrote the rows;
 * - a plain seed, `INSERT INTO <table> ... VALUES`, that the copy replaces with
 *   the source rows on purpose. Two conditions make that true. The seed detection
 *   of the copy finds the table, so the copy deletes the chain's rows before it
 *   writes the source's. And check:schema-parity holds both chains to the same
 *   seed rows in that table (its allowlist has no `rows:<table>` entry), so the
 *   source holds the operator's version of the same seed;
 * - explained in copy-migrations-allowlist.txt, one statement per line:
 *   `<migration>:<verb>:<table> -- <reason>`.
 *
 * Row-changing statements: INSERT, UPDATE, DELETE, MERGE, TRUNCATE, COPY FROM,
 * ALTER TABLE ... TYPE ... USING (a rewrite of stored values), and the
 * statements whose effect this check cannot read: DO, CALL, a top-level SELECT
 * (except `SELECT setval(...)`: the copy restarts every identity sequence), and
 * any statement kind it does not know. A WITH statement counts for each table it
 * writes. The body of a function is not a migration statement: it runs when the
 * function runs.
 *
 * An allowlist entry without a reason, or one that matches no statement, fails
 * the check (exit 1), as does an after-copy.json entry that names no migration.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chainSeededTables } from "../../packages/storage-postgres/src/data-copy";
import { readAllowlist } from "./check-schema-parity";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CHAIN_DIR = "src/be/migrations/postgres";
const ALLOWLIST_PATH = join(import.meta.dir, "copy-migrations-allowlist.txt");
const PARITY_ALLOWLIST_PATH = join(import.meta.dir, "schema-parity-allowlist.txt");

/** One statement that changes rows, or whose effect the check cannot read. */
export type RowChange = {
  /** insert, update, delete, merge, truncate, copy, alter-using, do, call, select, or an unknown kind. */
  verb: string;
  /** The table it writes, as Postgres resolves the name; `-` when the statement names none. */
  table: string;
  /** `INSERT INTO <table> ... VALUES`: rows written as they stand in the file. */
  plainSeed: boolean;
  /** The start of the statement, for the report. */
  text: string;
};

/**
 * The statements of a SQL file, split at each top-level `;`. Comments are removed
 * and the content of every string literal and dollar-quoted body is emptied, so a
 * keyword inside a comment, a JSON value or a function body is not read as a
 * statement. Quoted identifiers stay as written.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const end = () => {
    if (current.trim()) statements.push(current.trim().replace(/\s+/g, " "));
    current = "";
  };
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? sql.length : eol;
      current += " ";
    } else if (ch === "/" && next === "*") {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      current += " ";
    } else if (ch === "'") {
      // E'...' takes backslash escapes; every string doubles its quote.
      const escapes = /(^|[^A-Za-z0-9_$])[eE]$/.test(current);
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      current += "''";
    } else if (ch === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') break;
        else i++;
      }
      i++;
      current += sql.slice(start, i);
    } else if (ch === "$" && !/[A-Za-z0-9_$]$/.test(current)) {
      // $tag$ ... $tag$. A tag is empty or an identifier, so $1 is not a tag.
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (!tag) {
        current += ch;
        i++;
        continue;
      }
      const close = sql.indexOf(tag, i + tag.length);
      i = close === -1 ? sql.length : close + tag.length;
      current += "$$$$";
    } else if (ch === ";") {
      // A SQL-standard function body (BEGIN ATOMIC ... END) holds statements of
      // its own: the function ends at the `;` after END.
      const atomic = /^\s*CREATE\b[\s\S]*\bBEGIN\s+ATOMIC\b/i.test(current);
      if (atomic && !/\bEND\s*$/i.test(current)) current += ch;
      else end();
      i++;
    } else {
      current += ch;
      i++;
    }
  }
  end();
  return statements;
}

const NAME = `(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
/** A table name with an optional schema: the last part is the table. */
const TABLE = String.raw`(?:${NAME}\s*\.\s*)?(${NAME})`;

/** The name as Postgres resolves it: a quoted name as written, a bare name in lower case. */
function resolveName(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
}

const PLAIN_SEED = new RegExp(
  String.raw`^INSERT\s+INTO\s+${TABLE}(?:\s+AS\s+${NAME})?\s*(?:\([^()]*\))?\s*` +
    String.raw`(?:OVERRIDING\s+(?:SYSTEM|USER)\s+VALUE\s+)?(?:DEFAULT\s+)?VALUES\b`,
  "i",
);
/** Table writes anywhere in a statement (a WITH statement holds them in its parts). */
const WRITES: [string, RegExp][] = [
  ["insert", new RegExp(String.raw`\bINSERT\s+INTO\s+${TABLE}`, "gi")],
  // Not `ON CONFLICT ... DO UPDATE SET` and not a `FOR UPDATE` row lock.
  [
    "update",
    new RegExp(String.raw`(?<!\bDO\s+)(?<!\bFOR\s+)\bUPDATE\s+(?:ONLY\s+)?${TABLE}`, "gi"),
  ],
  ["delete", new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${TABLE}`, "gi")],
  ["merge", new RegExp(String.raw`\bMERGE\s+INTO\s+(?:ONLY\s+)?${TABLE}`, "gi")],
];
/** Statement kinds that change the schema, a setting or a privilege, and no table row. */
const SCHEMA_STATEMENTS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "COMMENT",
  "SET",
  "RESET",
  "GRANT",
  "REVOKE",
  "ANALYZE",
  "LOCK",
  "REINDEX",
]);

/** The row changes of one statement that `splitStatements` returned. */
export function rowChanges(statement: string): RowChange[] {
  const text = statement.length > 100 ? `${statement.slice(0, 100)}...` : statement;
  const change = (verb: string, table: string, plainSeed = false): RowChange => ({
    verb,
    table,
    plainSeed,
    text,
  });
  const head = /^[A-Za-z]+/.exec(statement)?.[0].toUpperCase() ?? "";
  const first = (pattern: string) => {
    const match = new RegExp(pattern, "i").exec(statement);
    return match?.[1] ? resolveName(match[1]) : "-";
  };
  switch (head) {
    case "INSERT":
      return [
        change("insert", first(String.raw`^INSERT\s+INTO\s+${TABLE}`), PLAIN_SEED.test(statement)),
      ];
    case "UPDATE":
      return [change("update", first(String.raw`^UPDATE\s+(?:ONLY\s+)?${TABLE}`))];
    case "DELETE":
      return [change("delete", first(String.raw`^DELETE\s+FROM\s+(?:ONLY\s+)?${TABLE}`))];
    case "MERGE":
      return [change("merge", first(String.raw`^MERGE\s+INTO\s+(?:ONLY\s+)?${TABLE}`))];
    case "TRUNCATE":
      return [change("truncate", first(String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${TABLE}`))];
    case "COPY":
      // COPY <table> TO and COPY (<query>) TO only read.
      return /\bFROM\b/i.test(statement)
        ? [change("copy", first(String.raw`^COPY\s+${TABLE}`))]
        : [];
    case "WITH": {
      const writes = WRITES.flatMap(([verb, pattern]) =>
        [...statement.matchAll(pattern)].map((match) =>
          change(verb, resolveName(match[1] as string)),
        ),
      );
      return writes.length > 0 ? writes : [change("select", "-")];
    }
    case "ALTER":
      return /^ALTER\s+TABLE\b[\s\S]*\bTYPE\b[\s\S]*\bUSING\b/i.test(statement)
        ? [
            change(
              "alter-using",
              first(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE}`),
            ),
          ]
        : [];
    case "SELECT":
      // The baseline moves each sequence past its seed keys. A sequence position is
      // no row, and db-copy restarts every identity sequence after it writes the rows.
      return /^SELECT\s+(?:pg_catalog\s*\.\s*)?setval\s*\(/i.test(statement)
        ? []
        : [change("select", "-")];
    default:
      // DO, CALL and every kind this check does not know: their effect on rows
      // cannot be read from the text.
      return SCHEMA_STATEMENTS.has(head) ? [] : [change(head.toLowerCase() || "unknown", "-")];
  }
}

export type CopyMigrationsInput = {
  /** The Postgres chain: `<name>.sql` files, in order. */
  migrations: { name: string; sql: string }[];
  /** `reapply` of after-copy.json. */
  reapply: string[];
  /** Tables the seed detection of db-copy finds in the chain. */
  seededTables: ReadonlySet<string>;
  /** Tables with a `rows:<table>` entry in the schema-parity allowlist. */
  seedExceptions: ReadonlySet<string>;
  /** copy-migrations-allowlist.txt: key to reason. */
  allowlist: ReadonlyMap<string, string>;
};

export type CopyMigrationsResult = {
  problems: string[];
  /** Counts for the success line. */
  seeds: number;
  rerun: number;
  explained: number;
};

export function checkCopyMigrations(input: CopyMigrationsInput): CopyMigrationsResult {
  const problems: string[] = [];
  const used = new Set<string>();
  let seeds = 0;
  let rerun = 0;
  let explained = 0;
  for (const name of input.reapply) {
    if (!input.migrations.some((migration) => migration.name === name))
      problems.push(`after-copy.json lists ${name}, which is not a migration in ${CHAIN_DIR}`);
  }
  for (const migration of input.migrations) {
    for (const statement of splitStatements(migration.sql)) {
      for (const change of rowChanges(statement)) {
        const key = `${migration.name}:${change.verb}:${change.table}`;
        if (input.allowlist.has(key)) {
          used.add(key);
          explained++;
          continue;
        }
        if (input.reapply.includes(migration.name)) {
          rerun++;
          continue;
        }
        if (!change.plainSeed) {
          problems.push(
            `${key}: db-copy undoes this statement. It runs on the empty target, then the copy writes the SQLite rows, ` +
              "and the API never runs the migration again.\n" +
              `    ${change.text}\n` +
              "    Fix one of: list the migration in after-copy.json (it must be safe to run twice and must not overwrite operator edits); " +
              "port the rows in db-copy itself (as metric-query-ports.json does for 370); " +
              `or, when the SQLite migration of this ordinal makes the same change to the source, add "${key} -- <reason>" to scripts/storage-checks/copy-migrations-allowlist.txt.`,
          );
          continue;
        }
        if (!input.seededTables.has(change.table)) {
          problems.push(
            `${key}: db-copy does not find this seed, so the chain's rows stay in the target and the copy refuses with a count difference.\n` +
              `    ${change.text}\n` +
              `    Write the statement as INSERT INTO "${change.table}" (no schema, the name as the table has it).`,
          );
          continue;
        }
        if (input.seedExceptions.has(change.table)) {
          problems.push(
            `${key}: schema-parity-allowlist.txt has rows:${change.table}, so the two chains may seed different rows here, and db-copy replaces this seed with the SQLite rows.\n` +
              `    ${change.text}\n` +
              `    When this seed is the same row on both engines, add "${key} -- <reason>" to scripts/storage-checks/copy-migrations-allowlist.txt. ` +
              "When it holds engine-specific content, db-copy must port it.",
          );
          continue;
        }
        seeds++;
      }
    }
  }
  for (const key of input.allowlist.keys()) {
    if (!used.has(key))
      problems.push(
        `copy-migrations-allowlist.txt: ${key} matches no statement. Remove the entry.`,
      );
  }
  return { problems, seeds, rerun, explained };
}

if (import.meta.main) {
  const dir = join(REPO_ROOT, CHAIN_DIR);
  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({
      name: file.replace(/\.sql$/, ""),
      sql: readFileSync(join(dir, file), "utf8"),
    }));
  const afterCopy = join(dir, "after-copy.json");
  const reapply = existsSync(afterCopy)
    ? ((JSON.parse(readFileSync(afterCopy, "utf8")) as { reapply?: string[] }).reapply ?? [])
    : [];
  const allowlist = readAllowlist(readFileSync(ALLOWLIST_PATH, "utf8"));
  const parity = readAllowlist(readFileSync(PARITY_ALLOWLIST_PATH, "utf8"));
  const result = checkCopyMigrations({
    migrations,
    reapply,
    seededTables: chainSeededTables(dir),
    seedExceptions: new Set(
      [...parity.entries.keys()]
        .filter((key) => key.startsWith("rows:"))
        .map((key) => key.slice("rows:".length)),
    ),
    allowlist: allowlist.entries,
  });
  const problems = [
    ...allowlist.errors.map((error) => `copy-migrations-allowlist.txt: ${error}`),
    ...result.problems,
  ];
  if (problems.length > 0) {
    console.error(
      `ERROR: ${problems.length} problem(s) with row-changing statements in ${CHAIN_DIR} (runbooks/postgres.md, "Rules for changes"):`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    `copy-migrations: ok (${migrations.length} Postgres migration(s): ${result.seeds} seed statement(s) the copy replaces, ` +
      `${result.rerun} rerun after the copy, ${result.explained} explained in the allowlist)`,
  );
}
