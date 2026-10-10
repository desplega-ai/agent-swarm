/**
 * CI-only: turn one shard's bun JUnit report into the compact `action: "tests"`
 * payload for the `ci-metrics` swarm script. The workflow posts the file with
 * curl; this script never talks to the network and never changes local
 * `bun test` behaviour (the JUnit reporter is only switched on in CI).
 *
 * Usage:
 *   bun scripts/ci-unit-test-report.ts --junit <report.xml> --out <payload.json>
 *     --shard 1/2 [--wall-ms 123] [--status success|failure]
 *
 * Every test's outcome is represented: failed and skipped tests are listed by
 * name, and per-file counts cover the passes. Per-test durations are sent for
 * tests at or above `--min-ms` (default 50); faster tests only add to their
 * file's total. The full JUnit report stays in the run's artifacts.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

export type TestStatus = "pass" | "fail" | "skip";

export type ParsedTest = {
  file: string;
  /** Describe chain plus test name, joined with " > ". */
  name: string;
  ms: number;
  status: TestStatus;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

/** Parse bun's JUnit output (nested testsuite per file, then per describe). */
export function parseJunit(xml: string): ParsedTest[] {
  const tests: ParsedTest[] = [];
  // Open testsuite elements; the outermost one per file is the file itself.
  const suites: { name: string; file: string }[] = [];
  let current: ParsedTest | null = null;
  const tag = /<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g;
  for (const m of xml.matchAll(tag)) {
    const [, closing, name, rawAttrs, selfClosing] = m;
    if (name === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) {
        const a = attrs(rawAttrs);
        suites.push({ name: a.name ?? "", file: a.file ?? a.name ?? "" });
      }
      continue;
    }
    if (name === "testcase") {
      if (closing) {
        if (current) tests.push(current);
        current = null;
        continue;
      }
      const a = attrs(rawAttrs);
      const file = a.file ?? suites[0]?.file ?? "";
      const describe = suites.filter((s) => s.name !== s.file).map((s) => s.name);
      const test: ParsedTest = {
        file,
        name: [...describe, a.name ?? ""].join(" > "),
        ms: Math.round(Number(a.time ?? 0) * 1000 * 10) / 10,
        status: "pass",
      };
      if (selfClosing) tests.push(test);
      else current = test;
      continue;
    }
    if (current && !closing) {
      if (name === "skipped") current.status = "skip";
      else current.status = "fail";
    }
  }
  return tests;
}

type FileRow = [path: string, blob: string | null, tests: number, fails: number, ms: number];
type TestRow = [fileIdx: number, name: string, ms: number, status: "p" | "f" | "s"];

export type TestsPayload = {
  action: "tests";
  v: 1;
  minMs: number;
  totals: { tests: number; pass: number; fail: number; skip: number; testMs: number };
  files: FileRow[];
  tests: TestRow[];
};

export function buildPayload(
  parsed: ParsedTest[],
  blobs: Map<string, string>,
  minMs: number,
): TestsPayload {
  const fileIdx = new Map<string, number>();
  const files: FileRow[] = [];
  const tests: TestRow[] = [];
  const totals = { tests: 0, pass: 0, fail: 0, skip: 0, testMs: 0 };
  for (const t of parsed) {
    let idx = fileIdx.get(t.file);
    if (idx === undefined) {
      idx = files.length;
      fileIdx.set(t.file, idx);
      files.push([t.file, blobs.get(t.file) ?? null, 0, 0, 0]);
    }
    const row = files[idx];
    row[2]++;
    row[4] += t.ms;
    totals.tests++;
    totals.testMs += t.ms;
    totals[t.status]++;
    if (t.status === "fail") row[3]++;
    if (t.status !== "pass" || t.ms >= minMs) {
      tests.push([
        idx,
        t.name.slice(0, 300),
        t.ms,
        t.status === "pass" ? "p" : (t.status[0] as "f" | "s"),
      ]);
    }
  }
  for (const row of files) row[4] = Math.round(row[4]);
  totals.testMs = Math.round(totals.testMs);
  return { action: "tests", v: 1, minMs, totals, files, tests };
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

/** Blob hash per tracked test file, so ingest can tell when a test file changed. */
function testFileBlobs(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of git(["ls-files", "-s", "--", "*.test.ts", "*.test.tsx"]).split("\n")) {
    const m = line.match(/^\d+ ([0-9a-f]+) \d+\t(.+)$/);
    if (m) out.set(m[2], m[1].slice(0, 12));
  }
  return out;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const junit = flag(argv, "junit");
  const out = flag(argv, "out");
  if (!junit || !out) throw new Error("usage: --junit <report.xml> --out <payload.json>");
  const [index, total] = (flag(argv, "shard") ?? "1/1").split("/").map(Number);
  const minMs = Number(flag(argv, "min-ms") ?? 50);
  const env = process.env;

  const parsed = parseJunit(await readFile(junit, "utf8"));
  if (parsed.length === 0) throw new Error(`no testcases in ${junit}`);
  const payload = buildPayload(parsed, testFileBlobs(), minMs);
  const pr = Number(env.PR_NUMBER);

  const body = {
    ...payload,
    repo: env.GITHUB_REPOSITORY ?? "desplega-ai/agent-swarm",
    // The commit and tree actually tested (PR runs test the merge ref).
    sha: git(["rev-parse", "HEAD"]) || env.GITHUB_SHA || null,
    tree: git(["rev-parse", "HEAD^{tree}"]) || null,
    headSha: env.HEAD_SHA || null,
    branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
    baseBranch: env.GITHUB_BASE_REF || "main",
    prNumber: Number.isFinite(pr) && pr > 0 ? pr : null,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT ?? 1),
    runUrl: env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null,
    event: env.GITHUB_EVENT_NAME ?? null,
    workflow: env.GITHUB_WORKFLOW ?? null,
    shard: { index: index || 1, total: total || 1 },
    wallMs: Number(flag(argv, "wall-ms") ?? 0) || null,
    status: flag(argv, "status") ?? null,
  };
  const json = JSON.stringify(body);
  await writeFile(out, json);
  console.log(
    `${payload.totals.tests} tests (${payload.totals.fail} fail, ${payload.totals.skip} skip) in ${payload.files.length} files; ${payload.tests.length} timed rows; ${json.length} bytes -> ${out}`,
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
