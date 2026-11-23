/**
 * check:sql-portability (Postgres brief check 13).
 *
 * 1. Every `sql` template in the storage packages quotes each identifier that
 *    contains an uppercase letter (decision D8): `"createdAt"`, never
 *    `createdAt`. Both engines then keep the camelCase names.
 * 2. SQLite-only syntax appears only in packages/storage-sqlite. The contracts
 *    package holds the portable SQL of the base repositories; a method that
 *    needs SQLite syntax is abstract there and lives in the SQLite package.
 */
import { listCodeFiles, literals, parse } from "./scan";

const SQLITE_ONLY: [RegExp, string][] = [
  [/\bstrftime\s*\(/i, "strftime()"],
  [/\bdatetime\s*\(/i, "datetime()"],
  [/\bjulianday\s*\(/i, "julianday()"],
  [/\bunixepoch\s*\(/i, "unixepoch()"],
  [/\bGLOB\b/i, "GLOB"],
  [/\browid\b/i, "rowid"],
  [/\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/i, "INSERT OR IGNORE/REPLACE"],
  [/\bREPLACE\s+INTO\b/i, "REPLACE INTO"],
  [/\bchanges\s*\(\s*\)/i, "changes()"],
  [/\blast_insert_rowid\b/i, "last_insert_rowid()"],
  [/\bjson_each\b/i, "json_each"],
  [/\bjson_extract\b/i, "json_extract"],
  [/\bjson_group_array\b/i, "json_group_array"],
  [/\bgroup_concat\b/i, "group_concat"],
  [/\bPRAGMA\b/i, "PRAGMA"],
  [/\bsqlite_master\b|\bsqlite_schema\b/i, "sqlite_master"],
  [/\bLIMIT\s+-1\b/i, "LIMIT -1"],
  [/\bIFNULL\s*\(/i, "IFNULL()"],
  [/\btypeof\s*\(/i, "typeof()"],
  [/\bMATCH\b/, "FTS5 MATCH"],
  [/\bIS\s+NOT\s+(?!NULL\b|DISTINCT\b)[?'"\w]/i, "IS NOT <value>"],
  [/\b(max|min)\s*\(\s*[^()]+,\s*[^()]+\)/i, "scalar max(a, b)/min(a, b)"],
];

/** Drop string literals, quoted identifiers and comments; keep the SQL words. */
function sqlWords(text: string): string {
  return text
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

const files = listCodeFiles(["packages/storage/src", "packages/storage-sqlite/src"]).concat(
  (() => {
    try {
      return listCodeFiles(["packages/storage-postgres/src"]);
    } catch {
      return [];
    }
  })(),
);
const failures: string[] = [];
let templates = 0;

for (const file of files) {
  const sqliteAllowed = file.startsWith("packages/storage-sqlite/");
  for (const literal of literals(parse(file))) {
    if (literal.tag !== "sql") continue;
    templates += 1;
    const words = sqlWords(literal.text);
    for (const match of words.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      const word = match[0];
      if (/[a-z]/.test(word) && /[A-Z]/.test(word)) {
        failures.push(
          `${file}:${literal.line} unquoted mixed-case identifier ${word} (D8: write "${word}")`,
        );
      }
    }
    if (sqliteAllowed) continue;
    for (const [pattern, name] of SQLITE_ONLY) {
      if (pattern.test(words)) {
        failures.push(
          `${file}:${literal.line} SQLite-only syntax ${name} outside packages/storage-sqlite`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`check:sql-portability failed (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`check:sql-portability passed (${templates} sql templates in ${files.length} files).`);
