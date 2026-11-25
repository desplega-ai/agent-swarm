// Compare two `bun run e2e --json` result files: per-group latency and scenario durations.
//
//   bun scripts/e2e/bench.ts /tmp/before.json /tmp/after.json [--md out.md]
//
// Engine mode (Postgres brief check 21): run the suite on SQLite and on Postgres, then
// report p95 per route group on both engines and the retry rate of each transaction site.
//
//   bun scripts/e2e/bench.ts --engine postgres [--only a,b] [--md e2e-bench-report.md]
//   (needs E2E_POSTGRES_URL, like `bun run e2e --engine postgres`)
//
// Exit code is 0 unless a file is unreadable. The numbers are for a human or a PR
// comment; thresholds belong to whoever reads them, not to this script.
//
// Commit budget (bench-budget.ts): the one gated mode. It counts Postgres commits and
// write statements per scenario and fails when a scenario goes over bench-budget.json.
//
//   bun scripts/e2e/bench.ts --check [--only a,b] [--results <dir>] [--md out.md]
//   bun scripts/e2e/bench.ts --write-budget [--only a,b] [--results <dir>]
//   bun scripts/e2e/bench.ts --collect <dir> [--shard i/6 | --only a,b] [--no-sqlite]
import { budgetMain } from "./bench-budget";

type Latency = { count: number; p50: number; p95: number; max: number };
type Result = {
  startedAt: string;
  durationMs: number;
  scenarios: Array<{ name: string; status: string; durationMs: number }>;
  coverage: {
    routes: { covered: number; total: number };
    mcpTools: { covered: number; total: number };
    nodeTypes?: { covered: number; total: number };
    latency?: { byGroup: Record<string, Latency>; overall: Latency };
  };
};

function usage(): never {
  console.error(
    "usage: bun scripts/e2e/bench.ts <before.json> <after.json> [--md <out.md>]\n" +
      "       bun scripts/e2e/bench.ts --engine postgres [--only <a,b>] [--md <out.md>]\n" +
      "       bun scripts/e2e/bench.ts --check | --write-budget | --collect <dir> (see bench-budget.ts)",
  );
  process.exit(2);
}

async function read(path: string): Promise<Result> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`not found: ${path}`);
    process.exit(2);
  }
  return (await file.json()) as Result;
}

function delta(before: number | undefined, after: number | undefined): string {
  if (before === undefined || after === undefined) return "";
  const diff = after - before;
  const pct = before === 0 ? 0 : (diff / before) * 100;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(0)}%)`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

type SiteStats = {
  transactions: number;
  retriedTransactions: number;
  retries: number;
  exhausted: number;
  errors: number;
  sqlstates: Record<string, number>;
};

/** One `bun run e2e` run; its exit code is reported, not fatal (the report is the product). */
async function runSuite(extra: string[], jsonPath: string): Promise<number> {
  const proc = Bun.spawn(["bun", "scripts/e2e/run.ts", "--json", jsonPath, ...extra], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

function retryTable(sites: Record<string, SiteStats>): string[] {
  const rows = Object.entries(sites).sort(
    ([, a], [, b]) =>
      b.retriedTransactions / b.transactions - a.retriedTransactions / a.transactions ||
      b.transactions - a.transactions,
  );
  const total = rows.reduce(
    (acc, [, s]) => ({
      transactions: acc.transactions + s.transactions,
      retried: acc.retried + s.retriedTransactions,
      exhausted: acc.exhausted + s.exhausted,
    }),
    { transactions: 0, retried: 0, exhausted: 0 },
  );
  const lines = [
    "### Postgres transaction retries by site",
    "",
    `${rows.length} sites, ${total.transactions} transactions, ${total.retried} retried, ${total.exhausted} exhausted retries. D7 threshold: a retry rate above 5% at a site.`,
    "",
    "| Site | Transactions | Retried | Retry rate | Retries | Exhausted | SQLSTATEs |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const [site, s] of rows) {
    const rate = s.transactions === 0 ? 0 : (s.retriedTransactions / s.transactions) * 100;
    const codes = Object.entries(s.sqlstates)
      .map(([code, n]) => `${code}×${n}`)
      .join(" ");
    lines.push(
      `| \`${site}\` | ${s.transactions} | ${s.retriedTransactions} | ${rate.toFixed(1)}%${rate > 5 ? " ⚠" : ""} | ${s.retries} | ${s.exhausted} | ${codes} |`,
    );
  }
  return lines;
}

async function engineMode(args: string[], mdPath: string): Promise<void> {
  const engine = args[args.indexOf("--engine") + 1];
  if (engine !== "postgres") usage();
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? ["--only", args[onlyIndex + 1] ?? ""] : [];
  const stamp = Date.now();
  const sqliteJson = `/tmp/e2e-bench-${stamp}-sqlite.json`;
  const postgresJson = `/tmp/e2e-bench-${stamp}-postgres.json`;
  const statsFile = `/tmp/e2e-bench-${stamp}-tx.json`;
  const sqliteExit = await runSuite(only, sqliteJson);
  const postgresExit = await runSuite(
    [...only, "--engine", "postgres", "--sut-env", `STORAGE_TX_STATS_FILE=${statsFile}`],
    postgresJson,
  );
  const [before, after] = await Promise.all([read(sqliteJson), read(postgresJson)]);
  const sites = (await Bun.file(statsFile).exists())
    ? ((await Bun.file(statsFile).json()) as Record<string, SiteStats>)
    : {};
  const markdown = [
    render(before, after, "SQLite", "Postgres").trimEnd(),
    "",
    `Suite exit codes: SQLite ${sqliteExit}, Postgres ${postgresExit}.`,
    "",
    ...retryTable(sites),
    "",
  ].join("\n");
  await Bun.write(mdPath, markdown);
  console.log(markdown);
  console.log(`report: ${mdPath}`);
  for (const path of [sqliteJson, postgresJson, statsFile])
    await Bun.file(path)
      .delete()
      .catch(() => {});
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mdIndex = args.indexOf("--md");
  const mdPath = mdIndex >= 0 ? args[mdIndex + 1] : undefined;
  if (["--check", "--write-budget", "--collect"].some((flag) => args.includes(flag))) {
    process.exitCode = await budgetMain(args);
    return;
  }
  if (args.includes("--engine")) {
    await engineMode(args, mdPath ?? "e2e-bench-report.md");
    return;
  }
  const files = args.filter(
    (arg, index) => arg !== "--md" && (mdIndex < 0 || index !== mdIndex + 1),
  );
  if (files.length !== 2 || (mdIndex >= 0 && !mdPath)) usage();
  const [before, after] = await Promise.all([read(files[0]!), read(files[1]!)]);
  const markdown = render(before, after, "Before", "After");
  if (mdPath) await Bun.write(mdPath, markdown);
  console.log(markdown);
}

function render(before: Result, after: Result, beforeLabel: string, afterLabel: string): string {
  const lines: string[] = [];
  lines.push(
    "## E2E benchmark",
    "",
    `${beforeLabel.toLowerCase()}: ${before.startedAt} (${seconds(before.durationMs)}), ${afterLabel.toLowerCase()}: ${after.startedAt} (${seconds(after.durationMs)})`,
    "",
    `| Surface | ${beforeLabel} | ${afterLabel} |`,
    "| --- | ---: | ---: |",
    `| routes covered | ${before.coverage.routes.covered}/${before.coverage.routes.total} | ${after.coverage.routes.covered}/${after.coverage.routes.total} |`,
    `| mcp tools covered | ${before.coverage.mcpTools.covered}/${before.coverage.mcpTools.total} | ${after.coverage.mcpTools.covered}/${after.coverage.mcpTools.total} |`,
    `| node types covered | ${before.coverage.nodeTypes?.covered ?? "n/a"}/${before.coverage.nodeTypes?.total ?? "n/a"} | ${after.coverage.nodeTypes?.covered ?? "n/a"}/${after.coverage.nodeTypes?.total ?? "n/a"} |`,
    "",
  );

  const beforeOverall = before.coverage.latency?.overall;
  const afterOverall = after.coverage.latency?.overall;
  lines.push(
    `| Latency | ${beforeLabel} p50 | ${afterLabel} p50 | Δ p50 | ${beforeLabel} p95 | ${afterLabel} p95 | Δ p95 | Calls ${beforeLabel} / ${afterLabel} |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| overall | ${beforeOverall?.p50 ?? ""} | ${afterOverall?.p50 ?? ""} | ${delta(beforeOverall?.p50, afterOverall?.p50)} | ${beforeOverall?.p95 ?? ""} | ${afterOverall?.p95 ?? ""} | ${delta(beforeOverall?.p95, afterOverall?.p95)} | ${beforeOverall?.count ?? 0} / ${afterOverall?.count ?? 0} |`,
  );
  const groups = new Set([
    ...Object.keys(before.coverage.latency?.byGroup ?? {}),
    ...Object.keys(after.coverage.latency?.byGroup ?? {}),
  ]);
  for (const group of [...groups].sort()) {
    const b = before.coverage.latency?.byGroup[group];
    const a = after.coverage.latency?.byGroup[group];
    lines.push(
      `| ${group} | ${b?.p50 ?? ""} | ${a?.p50 ?? ""} | ${delta(b?.p50, a?.p50)} | ${b?.p95 ?? ""} | ${a?.p95 ?? ""} | ${delta(b?.p95, a?.p95)} | ${b?.count ?? 0} / ${a?.count ?? 0} |`,
    );
  }

  lines.push(
    "",
    `| Scenario | ${beforeLabel} | ${afterLabel} | Δ |`,
    "| --- | ---: | ---: | ---: |",
  );
  const beforeScenarios = new Map(before.scenarios.map((scenario) => [scenario.name, scenario]));
  const afterScenarios = new Map(after.scenarios.map((scenario) => [scenario.name, scenario]));
  for (const name of [...new Set([...beforeScenarios.keys(), ...afterScenarios.keys()])].sort()) {
    const b = beforeScenarios.get(name);
    const a = afterScenarios.get(name);
    lines.push(
      `| ${name} | ${b ? `${seconds(b.durationMs)} ${b.status}` : ""} | ${a ? `${seconds(a.durationMs)} ${a.status}` : ""} | ${delta(b?.durationMs, a?.durationMs)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

await main();
