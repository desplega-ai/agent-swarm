/**
 * check:storage-boundary (Postgres brief check 12). No file outside the
 * storage packages contains SQL text or reaches the driver seam (`DbClient`,
 * `getDbClient`, `getDb`).
 *
 * The migration chain (`src/be/migrations/*.sql`) is not code and stays where
 * it is (brief section 4 forbids renaming those files); the engine runners
 * read it as data.
 *
 * Transition (M2): `storage-boundary-pending.json` lists the files that still
 * hold SQL, each with the domain it moves with and its counted sites. The
 * check fails when a file outside the list has a site, or a listed file gains
 * one. The list must be empty when M2 ends. Run with `--update` to shrink the
 * list after a move (it never adds a file).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { listCodeFiles, literals, parse, ROOT, SQL_STATEMENT } from "./scan";

const PENDING_PATH = join(import.meta.dir, "storage-boundary-pending.json");

/** Files that legitimately carry SQL text outside the storage packages. Reason on each line. */
const PERMANENT: Record<string, string> = {
  "src/be/storage-root.ts":
    "the composition root (brief D4): builds the engine client and storage, so it names DbClient",
  "src/be/sql-connections.ts":
    "user-configured external databases for scripts (ctx.sql); never the swarm database",
  "src/be/db/runtime.ts":
    "the engine-handle owner: opens the SQLite handle or starts the Postgres engine, so it names DbClient",
  "src/be/storage.ts":
    "builds the process Storage over the engine client from src/be/db/runtime.ts (the composition root's caller)",
  "src/be/scripts/typecheck.ts":
    "not SQL: the script SDK type declarations document db_query with example SQL in comments",
};

/** Directories whose SQL text is not storage access. Reason on each line. */
const PERMANENT_DIRS: Record<string, string> = {
  "src/be/seed-scripts/catalog/":
    "seeded scripts: read-only user SQL sent to db_query (decision D10), which runs it under the restricted reader in the engine's own dialect; each statement is portable or carries one text per dialect",
};

const isPermanent = (file: string): boolean =>
  Boolean(PERMANENT[file]) || Object.keys(PERMANENT_DIRS).some((dir) => file.startsWith(dir));

type Pending = Record<string, { reason: string; sites: number }>;

const DRIVER_SEAM = /^(DbClient|DbExecutor|getDbClient|getDb|createBunSqliteClient)$/;

function scanFile(file: string): { line: number; what: string }[] {
  const source = parse(file);
  const hits: { line: number; what: string }[] = [];
  for (const literal of literals(source)) {
    if (literal.tag === "sql" || SQL_STATEMENT.test(literal.text)) {
      hits.push({
        line: literal.line,
        what: `SQL text: ${literal.text.slice(0, 60).replace(/\s+/g, " ")}`,
      });
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && DRIVER_SEAM.test((node.propertyName ?? node.name).text)) {
      hits.push({
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        what: `imports ${(node.propertyName ?? node.name).text}`,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

/** The M2 move a pending file belongs to (the domain map in the ledger). */
function domainOf(file: string): string {
  const rules: [RegExp, string][] = [
    [/^src\/be\/memory\//, "memory (M2, engine search parts M4)"],
    [/^src\/be\/seed-scripts\//, "seeded db-query scripts (M4 step 4)"],
    [/db-query|search-read-worker|db-explorer/, "own database handle (M4 steps 4 and 5)"],
    [
      /^src\/be\/(db\/runtime|migrations\/|boot-|asset-key-audit|connection-bindings-blob|oauth-encryption-backfill)/,
      "boot path (M2 step 7)",
    ],
    [/^src\/workflows\/|workflow/, "workflows"],
    [/^src\/scheduler\/|schedule/, "schedules"],
    [/skill/, "skills"],
    [/^src\/be\/scripts\/|script/, "scripts"],
    [/session|cost|budget|pricing|savings|request-composition/, "sessions and cost"],
    [/task|checklist|routing/, "tasks"],
    [/user|rbac|role|permission|connector/, "users and RBAC"],
    [/agent|active-session|context-version/, "agents"],
    [/channel|inbox|agentmail|message/, "messaging"],
    [/page|metric|^src\/apps\/|primitive|favorite/, "pages, metrics, apps"],
    [/kv|realtime\/rooms/, "kv"],
    [/model/, "models"],
    [/runtime-pool/, "runtime pools"],
    [
      /slack|chat|tracker|mcp|oauth|codex|agent-fs|event|integration|linear|jira|github|gitlab/,
      "integrations",
    ],
    [/config|secret|api-key|repo|seed/, "config"],
    [/asset|import/, "assets and import"],
  ];
  for (const [pattern, domain] of rules) if (pattern.test(file)) return `M2 move: ${domain}`;
  return "M2 move: other (assign a domain when moved)";
}

const update = process.argv.includes("--update");
// --init seeds the list from the tree once, at the start of M2. Never rerun it
// to hide a new site: --update only shrinks the list.
const init = process.argv.includes("--init");
const pending: Pending = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
const files = listCodeFiles(["src"]);
const failures: string[] = [];
const next: Pending = {};
let pendingSites = 0;

for (const file of files) {
  if (isPermanent(file)) continue;
  const hits = scanFile(file);
  if (hits.length === 0) continue;
  const entry = init ? { reason: domainOf(file), sites: hits.length } : pending[file];
  if (!entry) {
    for (const hit of hits) failures.push(`${file}:${hit.line} ${hit.what}`);
    continue;
  }
  if (hits.length > entry.sites) {
    failures.push(
      `${file}: ${hits.length} storage sites, the pending list allows ${entry.sites}. Move the new SQL into a repository.`,
    );
  }
  next[file] = { reason: entry.reason, sites: Math.min(hits.length, entry.sites) };
  pendingSites += next[file].sites;
}

if (update || init) {
  writeFileSync(PENDING_PATH, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`storage-boundary: pending list rewritten (${Object.keys(next).length} files).`);
} else {
  const stale = Object.keys(pending).filter(
    (file) => !next[file] || next[file].sites < pending[file]!.sites,
  );
  if (stale.length > 0) {
    failures.push(
      `pending list is stale for ${stale.length} file(s) (moved or shrunk): run bun scripts/storage-checks/check-storage-boundary.ts --update`,
    );
  }
}

if (failures.length > 0) {
  console.error(`check:storage-boundary failed (${failures.length}):`);
  for (const failure of failures.slice(0, 200)) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `check:storage-boundary passed. Pending M2 moves: ${Object.keys(next).length} files, ${pendingSites} sites (must reach 0).`,
);
void ROOT;
