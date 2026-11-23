/**
 * `agent-swarm db-copy`: copy a SQLite database file into an empty Postgres
 * database (decision D11). The runbook (`runbooks/postgres.md`) gives the
 * production procedure around it.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scrubSecrets } from "../utils/secret-scrubber";
import { EMBEDDING_DIMENSIONS } from "./memory/constants";
import { copySqliteFileToPostgres, postgresUrlFromEnv } from "./storage-root";

export type DataCopyArgs = {
  from?: string;
  to?: string;
  json?: string;
};

export function parseDataCopyArgs(argv: string[]): DataCopyArgs | { error: string } {
  const args: DataCopyArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === "--from") args.from = value();
    else if (flag === "--to") args.to = value();
    else if (flag === "--json") args.json = value();
    else return { error: `Unknown option: ${arg}` };
  }
  return args;
}

/**
 * Returns the process exit code: 0 when every table compared equal, 1 when the copy
 * failed (nothing committed), 2 for a usage error, 3 when the copy committed but the
 * --json report could not be written.
 */
export async function runDataCopyCommand(argv: string[]): Promise<number> {
  const parsed = parseDataCopyArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const from = parsed.from ?? process.env.DATABASE_PATH;
  const to = parsed.to ?? (postgresUrlFromEnv() || undefined);
  if (!from) {
    console.error("db-copy needs the SQLite file: --from <path> (or DATABASE_PATH)");
    return 2;
  }
  if (!existsSync(from)) {
    console.error(`db-copy: no SQLite file at ${from}`);
    return 2;
  }
  if (parsed.json && reportWouldOverwriteSource(parsed.json, from)) {
    console.error(
      `db-copy: --json ${parsed.json} is the SQLite source (or its -wal/-shm file); pick another report path`,
    );
    return 2;
  }
  const reportProblem = parsed.json ? reportPathProblem(parsed.json) : null;
  if (reportProblem) {
    console.error(`db-copy: --json ${parsed.json} ${reportProblem}; pick another report path`);
    return 2;
  }
  if (!to || !/^postgres(ql)?:\/\//.test(to)) {
    console.error("db-copy needs the target: --to postgres://... (or DATABASE_URL)");
    return 2;
  }

  console.log(scrubSecrets(`[db-copy] ${from} -> ${to}`));
  const report = await copySqliteFileToPostgres({
    sqlitePath: from,
    postgresUrl: to,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    log: (line) => console.log(scrubSecrets(line)),
  });

  for (const skipped of report.skipped) {
    console.log(`[db-copy] skipped ${skipped.name}: ${skipped.reason}`);
  }
  for (const rebuilt of report.rebuilt) {
    console.log(`[db-copy] rebuilt ${rebuilt.table}: ${rebuilt.rows} rows (${rebuilt.reason})`);
  }
  for (const problem of report.problems.slice(0, 200)) {
    console.error(
      scrubSecrets(
        `[db-copy] cannot store ${problem.table}.${problem.column} (${problem.row}): ${problem.reason}`,
      ),
    );
  }
  if (report.problemCount > 200) {
    console.error(
      `[db-copy] ... and ${report.problemCount - 200} more${parsed.json ? ` (all in ${parsed.json})` : " (--json lists all)"}`,
    );
  }
  for (const item of report.attention ?? []) {
    console.warn(
      scrubSecrets(`[db-copy] ATTENTION ${item.table} ${item.row}, ${item.column}: ${item.reason}`),
    );
  }
  for (const table of report.tables.filter((t) => !t.equal)) {
    console.error(
      `[db-copy] MISMATCH ${table.table}: rows ${table.sourceRows} -> ${table.targetRows}, checksum ${table.sourceChecksum.slice(0, 12)} -> ${table.targetChecksum.slice(0, 12)}`,
    );
  }
  const rows = report.tables.reduce((sum, t) => sum + t.targetRows, 0);
  if (parsed.json) {
    try {
      await Bun.write(parsed.json, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      const outcome = report.ok
        ? "The database copy COMMITTED: the target holds the copied data. Only the report is missing."
        : "The copy did not commit.";
      console.error(
        `[db-copy] cannot write the report ${parsed.json}: ${(error as Error).message}. ${outcome}`,
      );
      // 3: committed, report missing. Distinct from 1 (copy failed).
      return report.ok ? 3 : 1;
    }
  }
  if (report.ok) {
    console.log(
      `[db-copy] done: ${report.tables.length} tables, ${rows} rows, every count and checksum equal`,
    );
    return 0;
  }
  console.error(scrubSecrets(`[db-copy] FAILED: ${report.error ?? "unknown error"}`));
  return 1;
}

/**
 * True when the report path names the source file or one of its WAL files,
 * by path or by file identity (a hard link or symlink). The source is resolved
 * to its real path first: SQLite opens `<real path>-wal`, so a symlink given as
 * `--from` must not hide the real WAL. The check runs before the copy starts, so
 * a refused copy never replaces the rollback file.
 */
export function reportWouldOverwriteSource(reportPath: string, sqlitePath: string): boolean {
  const report = resolve(reportPath);
  const bases = new Set([resolve(sqlitePath)]);
  try {
    bases.add(realpathSync(sqlitePath));
  } catch {
    // A missing source is reported by the caller.
  }
  const sources = [...bases].flatMap((base) => [base, `${base}-wal`, `${base}-shm`]);
  if (sources.includes(report)) return true;
  if (existsSync(report)) {
    try {
      if (sources.includes(realpathSync(report))) return true;
    } catch {
      // Fall through to the identity check.
    }
  }
  if (!existsSync(report)) return false;
  const target = statSync(report);
  return sources.some((source) => {
    if (!existsSync(source)) return false;
    const stat = statSync(source);
    return stat.dev === target.dev && stat.ino === target.ino;
  });
}

/**
 * Why the report cannot be written, checked before the copy starts: a directory,
 * a missing or read-only parent directory, or a read-only file. Null when writable.
 */
export function reportPathProblem(reportPath: string): string | null {
  const report = resolve(reportPath);
  if (existsSync(report)) {
    if (statSync(report).isDirectory()) return "is a directory";
    try {
      accessSync(report, constants.W_OK);
    } catch {
      return "is not writable";
    }
    return null;
  }
  const parent = dirname(report);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    return `has no parent directory ${parent}`;
  }
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    return `cannot be created in ${parent}`;
  }
  return null;
}
