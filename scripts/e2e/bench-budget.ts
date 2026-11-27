// The PostgreSQL commit budget (`bun run e2e:bench --check`, nightly workflow
// nightly-commit-budget.yml). For each scenario, bench-budget.json holds the most Postgres
// commits and write statements that one HTTP request (or MCP call) of the scenario may make.
// Durations depend on the runner, these counts do not: a request that commits once per row
// makes the same number of commits on every machine. Totals per scenario are no gate: they
// also count pollers and timers, so they change with the scenario's duration.
//
//   bun scripts/e2e/bench.ts --collect <dir> [--shard i/6 | --only a,b] [--no-sqlite] [--jobs 2]
//   bun scripts/e2e/bench.ts --check [--results <dir>]... [--only a,b] [--md out.md] [--issue-out issue.md]
//   bun scripts/e2e/bench.ts --write-budget [--results <dir>]... [--only a,b]
//
// Without `--results`, `--check` and `--write-budget` collect first, into a temporary
// directory. Needs E2E_POSTGRES_URL, like `bun run e2e --engine postgres`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BUDGET_PATH = `${import.meta.dir}/bench-budget.json`;
const SHARD_COUNT = 6;
/** Headroom of a regenerated budget: the measured value plus 20 percent, at least plus 10. */
const HEADROOM_PERCENT = 20;
const HEADROOM_MINIMUM = 10;

/** The most that one request of the scenario made. */
type Counts = { commits: number; writeStatements: number };
type BudgetEntry = Counts & { measured: Counts };
type Budget = {
  about: string;
  headroom: { percent: number; minimum: number };
  scenarios: Record<string, BudgetEntry>;
};
type ResultScenario = {
  name: string;
  status: string;
  durationMs: number;
  storage?: {
    commits: number;
    writeStatements: number;
    maxRequestCommits: number;
    maxRequestCommitsPath: string;
    maxRequestWriteStatements: number;
    maxRequestWriteStatementsPath: string;
  };
};
type ResultFile = { ok?: boolean; scenarios: ResultScenario[] };

/** What the result files of one or more collections say about each scenario. */
type Measurements = {
  /** Highest counts over the passing Postgres runs of each scenario. */
  counts: Map<string, Counts>;
  /** The request (method and first path segments) behind each highest count. */
  paths: Map<string, { commits: string; writeStatements: string }>;
  /** Commits of the whole scenario (all requests and background work), for information. */
  totalCommits: Map<string, number>;
  /** Postgres status of a scenario with no passing run (fail, flaky, skip). */
  notPassing: Map<string, string>;
  postgresMs: Map<string, number>;
  sqliteMs: Map<string, number>;
  postgresFiles: number;
  suitesOk: boolean;
};

const ABOUT =
  "Per e2e scenario: the most Postgres commits and write statements that one HTTP request may make. Regenerate with `bun run e2e:bench --write-budget` (scripts/e2e/README.md, Commit budget).";

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag && args[index + 1] ? [args[index + 1]!] : []));
}

/**
 * One `bun run e2e` run. Its output goes to `logPath` (bands at the same time would mix
 * their lines), or to this process's stdout without one. The exit code is kept, not fatal.
 */
async function runSuite(extra: string[], logPath?: string): Promise<number> {
  const proc = Bun.spawn(["bun", `${import.meta.dir}/run.ts`, ...extra], {
    stdout: logPath ? Bun.file(logPath) : "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

/**
 * Run the suite into `dir`: per band, SQLite (for the duration ratio, unless `sqlite` is
 * false), then Postgres with `--write-stats`. The bands of `--shard` are the bands Merge
 * Gate uses, so each scenario starts from the same state as in CI. `jobs` bands run at the
 * same time; `only` runs one process with those scenarios instead.
 */
export async function collect(
  dir: string,
  options: { shard?: number; only?: string; sqlite: boolean; jobs: number },
): Promise<void> {
  await Bun.$`mkdir -p ${dir}`.quiet();
  const bands: (number | undefined)[] = options.only
    ? [undefined]
    : options.shard
      ? [options.shard]
      : Array.from({ length: SHARD_COUNT }, (_, index) => index + 1);
  // One band prints to the console (CI). Several bands each write a log file in `dir`.
  const logOf = (name: string) => (bands.length > 1 ? join(dir, `${name}.log`) : undefined);
  const runBand = async (band: number | undefined) => {
    const label = band ? `shard-${band}` : "only";
    const select = band ? ["--shard", `${band}/${SHARD_COUNT}`] : ["--only", options.only ?? ""];
    if (options.sqlite) {
      const log = logOf(`sqlite-${label}`);
      const code = await runSuite([...select, "--json", join(dir, `sqlite-${label}.json`)], log);
      console.log(`SQLite ${label}: exit ${code}${log ? ` (log ${log})` : ""}`);
    }
    const log = logOf(`postgres-${label}`);
    const code = await runSuite(
      [
        ...select,
        "--engine",
        "postgres",
        "--write-stats",
        join(dir, `write-stats-${label}`),
        "--json",
        join(dir, `postgres-${label}.json`),
      ],
      log,
    );
    console.log(`Postgres ${label}: exit ${code}${log ? ` (log ${log})` : ""}`);
  };
  // `jobs` bands at a time: six API processes that boot at once can miss the boot timeout.
  const queue = [...bands];
  await Promise.all(
    Array.from({ length: Math.min(options.jobs, queue.length) }, async () => {
      while (queue.length > 0) await runBand(queue.shift());
    }),
  );
}

async function readResults(dir: string, engine: "postgres" | "sqlite"): Promise<ResultFile[]> {
  const files = [...new Bun.Glob(`${engine}-*.json`).scanSync(dir)].sort();
  return Promise.all(
    files.map(async (file) => (await Bun.file(join(dir, file)).json()) as ResultFile),
  );
}

export async function measure(dirs: string[]): Promise<Measurements> {
  const m: Measurements = {
    counts: new Map(),
    paths: new Map(),
    totalCommits: new Map(),
    notPassing: new Map(),
    postgresMs: new Map(),
    sqliteMs: new Map(),
    postgresFiles: 0,
    suitesOk: true,
  };
  for (const dir of dirs) {
    const postgres = await readResults(dir, "postgres");
    m.postgresFiles += postgres.length;
    for (const file of postgres) {
      if (file.ok === false) m.suitesOk = false;
      for (const scenario of file.scenarios) {
        m.postgresMs.set(
          scenario.name,
          Math.max(m.postgresMs.get(scenario.name) ?? 0, scenario.durationMs),
        );
        if (scenario.status !== "pass" || !scenario.storage) {
          if (!m.counts.has(scenario.name)) m.notPassing.set(scenario.name, scenario.status);
          continue;
        }
        m.notPassing.delete(scenario.name);
        const storage = scenario.storage;
        const seen = m.counts.get(scenario.name);
        const path = m.paths.get(scenario.name) ?? { commits: "", writeStatements: "" };
        if (!seen || storage.maxRequestCommits > seen.commits) {
          path.commits = storage.maxRequestCommitsPath;
        }
        if (!seen || storage.maxRequestWriteStatements > seen.writeStatements) {
          path.writeStatements = storage.maxRequestWriteStatementsPath;
        }
        m.paths.set(scenario.name, path);
        m.counts.set(scenario.name, {
          commits: Math.max(seen?.commits ?? 0, storage.maxRequestCommits),
          writeStatements: Math.max(seen?.writeStatements ?? 0, storage.maxRequestWriteStatements),
        });
        m.totalCommits.set(
          scenario.name,
          Math.max(m.totalCommits.get(scenario.name) ?? 0, storage.commits),
        );
      }
    }
    for (const file of await readResults(dir, "sqlite")) {
      for (const scenario of file.scenarios) {
        if (scenario.status === "skip") continue;
        m.sqliteMs.set(
          scenario.name,
          Math.max(m.sqliteMs.get(scenario.name) ?? 0, scenario.durationMs),
        );
      }
    }
  }
  return m;
}

function withHeadroom(value: number): number {
  return Math.max(Math.ceil(value * (1 + HEADROOM_PERCENT / 100)), value + HEADROOM_MINIMUM);
}

async function readBudget(path: string): Promise<Budget> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return {
      about: ABOUT,
      headroom: { percent: HEADROOM_PERCENT, minimum: HEADROOM_MINIMUM },
      scenarios: {},
    };
  }
  return (await file.json()) as Budget;
}

/**
 * Write the budget from the measurements. With `only`, update those scenarios and keep
 * the rest. A scenario with no passing run keeps its old entry.
 */
export async function writeBudget(m: Measurements, path: string, only?: Set<string>) {
  const old = await readBudget(path);
  const scenarios: Record<string, BudgetEntry> = only ? { ...old.scenarios } : {};
  for (const [name, counts] of m.counts) {
    if (only && !only.has(name)) continue;
    scenarios[name] = {
      commits: withHeadroom(counts.commits),
      writeStatements: withHeadroom(counts.writeStatements),
      measured: counts,
    };
  }
  for (const [name, status] of m.notPassing) {
    if (only && !only.has(name)) continue;
    const kept = old.scenarios[name];
    if (kept) scenarios[name] = kept;
    console.warn(
      `${name}: ${status} on Postgres, no new budget${kept ? " (kept the old entry)" : ""}`,
    );
  }
  const sorted = Object.fromEntries(
    Object.entries(scenarios).sort(([a], [b]) => a.localeCompare(b)),
  );
  const budget: Budget = {
    about: ABOUT,
    headroom: { percent: HEADROOM_PERCENT, minimum: HEADROOM_MINIMUM },
    scenarios: sorted,
  };
  await Bun.write(path, `${JSON.stringify(budget, null, 2)}\n`);
  console.log(`budget: ${Object.keys(sorted).length} scenarios in ${path}`);
}

type Overrun = { name: string; counts: Counts; budget: BudgetEntry };

function seconds(ms: number | undefined): string {
  return ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)}s`;
}

function ratio(name: string, m: Measurements): string {
  const postgres = m.postgresMs.get(name);
  const sqlite = m.sqliteMs.get(name);
  if (postgres === undefined || sqlite === undefined || sqlite === 0) return "n/a";
  return `${(postgres / sqlite).toFixed(1)}x`;
}

function cell(value: number, max: number): string {
  return value > max ? `**${value}** / ${max}` : `${value} / ${max}`;
}

/** The report of a check, and whether it passed. */
export function check(
  m: Measurements,
  budget: Budget,
  only?: Set<string>,
): { ok: boolean; markdown: string; overruns: Overrun[] } {
  const overruns: Overrun[] = [];
  const missing: string[] = [];
  const unbudgeted: string[] = [];
  for (const [name, entry] of Object.entries(budget.scenarios)) {
    if (only && !only.has(name)) continue;
    const counts = m.counts.get(name);
    if (!counts) {
      if (!m.notPassing.has(name)) missing.push(name);
      continue;
    }
    if (counts.commits > entry.commits || counts.writeStatements > entry.writeStatements) {
      overruns.push({ name, counts, budget: entry });
    }
  }
  for (const name of m.counts.keys()) if (!budget.scenarios[name]) unbudgeted.push(name);
  overruns.sort(
    (a, b) => b.counts.commits / b.budget.commits - a.counts.commits / a.budget.commits,
  );
  // A full run that measured nothing for a budgeted scenario lost a band: fail, so a
  // crashed shard cannot pass the check forever. `--only` runs a subset on purpose.
  const lostScenarios = !only && missing.length > 0;
  const ok = overruns.length === 0 && !lostScenarios && m.postgresFiles > 0;

  const lines = ["## Postgres commit budget", ""];
  if (m.postgresFiles === 0) lines.push("No Postgres result file: nothing was measured.", "");
  lines.push(
    overruns.length === 0
      ? `All ${m.counts.size} measured scenarios are within budget.`
      : `${overruns.length} scenario(s) over budget. Each cell is measured / budget, for the request with the most commits or write statements.`,
    "",
  );
  if (overruns.length > 0) {
    lines.push(
      "| Scenario | Request | Commits | Write statements | Postgres / SQLite time |",
      "| --- | --- | ---: | ---: | ---: |",
    );
    for (const o of overruns) {
      lines.push(
        `| \`${o.name}\` | \`${m.paths.get(o.name)?.commits || "n/a"}\` | ${cell(o.counts.commits, o.budget.commits)} | ${cell(o.counts.writeStatements, o.budget.writeStatements)} | ${ratio(o.name, m)} |`,
      );
    }
    lines.push("");
  }
  if (missing.length > 0) {
    lines.push(
      `Not measured (no result${only ? "" : ", this fails the check"}): ${missing.map((name) => `\`${name}\``).join(", ")}.`,
      "",
    );
  }
  const notPassing = [...m.notPassing].filter(([name]) => !only || only.has(name));
  if (notPassing.length > 0) {
    lines.push(
      `Not checked (no passing Postgres run): ${notPassing.map(([name, status]) => `\`${name}\` (${status})`).join(", ")}.`,
      "",
    );
  }
  if (unbudgeted.length > 0) {
    lines.push(
      `No budget yet (regenerate the budget to add them): ${unbudgeted.map((name) => `\`${name}\``).join(", ")}.`,
      "",
    );
  }
  if (!m.suitesOk) lines.push("A Postgres suite run did not pass. See its log.", "");

  // Durations are for information only: they depend on the runner.
  const timed = [...m.postgresMs.keys()]
    .filter((name) => m.sqliteMs.has(name))
    .map((name) => ({
      name,
      postgres: m.postgresMs.get(name) ?? 0,
      sqlite: m.sqliteMs.get(name) ?? 0,
    }))
    .sort((a, b) => b.postgres / Math.max(b.sqlite, 1) - a.postgres / Math.max(a.sqlite, 1));
  if (timed.length > 0) {
    lines.push(
      "<details><summary>Postgres / SQLite duration per scenario (information only, not gated)</summary>",
      "",
      "| Scenario | Postgres | SQLite | Ratio | Commits (all) |",
      "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const t of timed) {
      lines.push(
        `| \`${t.name}\` | ${seconds(t.postgres)} | ${seconds(t.sqlite)} | ${ratio(t.name, m)} | ${m.totalCommits.get(t.name) ?? "n/a"} |`,
      );
    }
    lines.push("", "</details>", "");
  }
  return { ok, markdown: `${lines.join("\n")}\n`, overruns };
}

/** The issue body, with the headings of .github/ISSUE_TEMPLATE/bug_report.yml. */
function issueBody(report: string, runUrl: string | undefined, sha: string | undefined): string {
  return [
    "### Intent",
    "",
    "The nightly PostgreSQL commit budget failed. An HTTP request of a scenario now makes more Postgres commits or write statements than `scripts/e2e/bench-budget.json` allows. On PostgreSQL each commit waits for a WAL flush, so extra commits make a request slow. Find the change that added them. If the change is intended, regenerate the budget in the same PR.",
    "",
    "### Repro",
    "",
    "1. Start PostgreSQL 18 with pgvector and set `E2E_POSTGRES_URL`.",
    "2. Run `bun run e2e:bench --check --only <scenario>` on the commit below.",
    "3. The check prints the scenarios over budget.",
    "",
    "### Setup",
    "",
    `- Version or commit: ${sha ?? "unknown"}`,
    "- Deployment: CI, Nightly PostgreSQL commit budget workflow",
    "- Agent roster: none (black-box e2e suite with a simulated agent)",
    "- Harness providers: none",
    "",
    "### Proof",
    "",
    runUrl ? `Run: ${runUrl}` : "Run: local",
    "",
    report.trimEnd(),
    "",
    "### Urgency",
    "",
    "nice to have",
    "",
    "### Component",
    "",
    "API Server",
    "",
  ].join("\n");
}

export async function budgetMain(args: string[]): Promise<number> {
  const budgetPath = flagValue(args, "--budget") ?? BUDGET_PATH;
  const only = flagValue(args, "--only");
  const onlySet = only ? new Set(only.split(",").map((name) => name.trim())) : undefined;
  const shardValue = flagValue(args, "--shard");
  const shard = shardValue ? Number(/^(\d+)\/6$/.exec(shardValue)?.[1]) : undefined;
  if (shardValue && !(shard && shard >= 1 && shard <= SHARD_COUNT)) {
    throw new Error(`--shard must be i/${SHARD_COUNT}`);
  }
  const jobs = Number(flagValue(args, "--jobs") ?? "2");
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error("--jobs must be a positive integer");
  const collectDir = flagValue(args, "--collect");
  if (collectDir) {
    await collect(collectDir, { shard, only, jobs, sqlite: !args.includes("--no-sqlite") });
    return 0;
  }
  const writing = args.includes("--write-budget");
  let dirs = flagValues(args, "--results");
  let temp: string | undefined;
  if (dirs.length === 0) {
    temp = await mkdtemp(join(tmpdir(), "e2e-bench-budget-"));
    // Writing a budget needs no durations: skip the SQLite runs.
    await collect(temp, { shard, only, jobs, sqlite: !writing });
    dirs = [temp];
  }
  try {
    const m = await measure(dirs);
    if (writing) {
      await writeBudget(m, budgetPath, onlySet);
      return 0;
    }
    const result = check(m, await readBudget(budgetPath), onlySet);
    console.log(result.markdown);
    const mdPath = flagValue(args, "--md");
    if (mdPath) await Bun.write(mdPath, result.markdown);
    const issuePath = flagValue(args, "--issue-out");
    if (issuePath) {
      await Bun.write(
        issuePath,
        issueBody(result.markdown, flagValue(args, "--run-url"), flagValue(args, "--sha")),
      );
    }
    return result.ok ? 0 : 1;
  } finally {
    if (temp && !args.includes("--keep")) await rm(temp, { recursive: true, force: true });
  }
}
