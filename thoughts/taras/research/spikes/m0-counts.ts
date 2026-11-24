// M0 recount of brief section 6 numbers. Regex matches are upper bounds, not parsed SQL.
// Excludes tests, migrations and node_modules. Run from the repo root: bun thoughts/taras/research/spikes/m0-counts.ts
const glob = new Bun.Glob("src/**/*.{ts,tsx}");
const files: Array<[string, string]> = [];
for await (const f of glob.scan(".")) {
  if (f.startsWith("src/tests/") || f.includes(".test.") || f.startsWith("src/be/migrations/"))
    continue;
  files.push([f, await Bun.file(f).text()]);
}
const count = (re: RegExp, filter: (f: string) => boolean = () => true) => {
  let m = 0,
    n = 0;
  for (const [f, t] of files) {
    if (!filter(f)) continue;
    const k = (
      t.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) ?? []
    ).length;
    if (k) {
      m += k;
      n++;
    }
  }
  return `${m} matches in ${n} files`;
};
const rows: Array<[string, RegExp]> = [
  ["getDbClient() call sites", /getDbClient\(\)/],
  [".transaction( sites", /\.transaction\(/],
  ["new Database( openers", /new Database\(/],
  ["bun:sqlite importers", /from "bun:sqlite"/],
  [
    "SQL statements (string starting with SELECT/INSERT/UPDATE/DELETE/WITH)",
    /[`"']\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\s/i,
  ],
  ['IN-list expansions (map(() => "?"))', /map\(\(\) => [`"']\?[`"']\)/],
  [
    'placeholders join(", ") / WHERE-fragment arrays (conditions.push)',
    /(conditions|where|clauses|filters)\.push\(/,
  ],
  ["strftime(", /strftime\(/],
  ["datetime('now'", /datetime\('now'/],
  ["IS NOT <value> (uppercase, not NULL)", /\bIS NOT (?!NULL\b)(?!DISTINCT)/],
  ["GLOB", /\bGLOB\b/],
  ["rowid", /\browid\b/i],
  ["INSERT OR IGNORE/REPLACE", /INSERT OR (IGNORE|REPLACE)/i],
  ["changes() / .changes / lastInsertRowid", /changes\(\)|\.changes\b|lastInsertRowid/],
  ["json_each", /json_each/],
  ["json_extract", /json_extract/],
  ["PRAGMA", /\bPRAGMA\b/],
  ["LIKE", /\bLIKE\b/],
  ["scalar max(a,b)/min(a,b) in SQL", /\b(MAX|MIN)\([^()'`]*,[^()'`]*\)/],
  ["rowTo* mappers", /function rowTo|const rowTo/],
  [
    "SQLite error text matches",
    /SQLITE_[A-Z]|UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed|no such table|database is locked/,
  ],
];
for (const [label, re] of rows) console.log(`${label}: ${count(re)}`);
let jp = 0;
for (const [, t] of files)
  if (/function rowTo|const rowTo/.test(t)) jp += (t.match(/JSON\.parse/g) ?? []).length;
console.log(`JSON.parse in files with rowTo* mappers: ${jp}`);
console.log("getDbClient() by directory:");
for (const d of [
  "src/be/db.ts",
  "src/be/db/",
  "src/be/db-queries/",
  "src/http/",
  "src/be/memory/",
  "src/workflows/",
  "src/tools/",
  "src/apps/",
  "src/scheduler/",
  "src/heartbeat/",
])
  console.log(`  ${d}: ${count(/getDbClient\(\)/, (f) => f.startsWith(d))}`);
const seam = await Bun.file("scripts/check-async-db-seam.sh").text();
console.log(
  `check-async-db-seam.sh allowlist entries: ${(seam.match(/^\s*"?src\/[^\s"]+/gm) ?? []).length}`,
);
let seed = 0;
for await (const f of new Bun.Glob("src/be/seed-scripts/**/*").scan(".")) {
  const t = await Bun.file(f).text();
  seed += t
    .split("\n")
    .filter((l) => /\b(SELECT|FROM|WHERE|JOIN|GROUP BY|ORDER BY)\b/.test(l)).length;
}
console.log(`seed-scripts lines with SQL keywords: ${seed}`);
let mig = 0,
  trig = 0;
for await (const f of new Bun.Glob("src/be/migrations/*.sql").scan(".")) {
  mig++;
  trig += ((await Bun.file(f).text()).match(/CREATE TRIGGER/gi) ?? []).length;
}
console.log(`migration files: ${mig}; CREATE TRIGGER statements across migrations: ${trig}`);
let docs = 0;
for await (const f of new Bun.Glob("docs-site/content/**/*.{md,mdx}").scan("."))
  if (/sqlite/i.test(await Bun.file(f).text())) docs++;
console.log(`docs-site pages naming SQLite: ${docs}`);
