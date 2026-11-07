/**
 * Public, read-only benchmark endpoints (swarm-evals plan v2, Phase 10). The
 * ONLY `/api/*` routes that skip EVALS_API_KEY: they serve the frozen snapshots
 * `bun src/cli.ts publish` wrote to disk, never live data, so nothing here reads
 * the DB. Layout: `<benchmarkDir>/<suiteVersion>/<YYYY-MM-DD>/snapshot.json`, one
 * dated directory per publish (UTC day of `publishedAt`), so earlier weeks stay
 * browsable. A dated directory without `snapshot.json` is not listed.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
/** Where snapshots live (`apps/evals/benchmark/<version>/<date>/`); override: EVALS_BENCHMARK_DIR. */
export const DEFAULT_BENCHMARK_DIR = join(import.meta.dir, "../../benchmark");

export function benchmarkDir(): string {
  return process.env.EVALS_BENCHMARK_DIR || DEFAULT_BENCHMARK_DIR;
}

const VERSION_RE = /^[0-9]+\.[0-9]+$/;
const SNAPSHOT_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The dated directory a publish at `publishedAt` writes to (UTC day). */
export function snapshotDay(publishedAt: string): string {
  return publishedAt.slice(0, 10);
}

export interface BenchmarkVersion {
  suiteVersion: string;
  /** `YYYY-MM-DD` directory name; with `suiteVersion` it names one snapshot. */
  snapshot: string;
  publishedAt: string | null;
}

export interface BenchmarkIndex {
  /** One entry per published snapshot, newest first. Empty until one is published. */
  versions: BenchmarkVersion[];
  /** Suite version of `versions[0]`. */
  latest: string | null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}

function byVersionDesc(a: string, b: string): number {
  const [amaj = 0, amin = 0] = a.split(".").map(Number);
  const [bmaj = 0, bmin = 0] = b.split(".").map(Number);
  return bmaj - amaj || bmin - amin;
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export async function listBenchmarkVersions(dir = benchmarkDir()): Promise<BenchmarkIndex> {
  const versions: BenchmarkVersion[] = [];
  const suites = (await readDir(dir)).filter((e) => VERSION_RE.test(e));
  for (const suiteVersion of suites) {
    const days = (await readDir(join(dir, suiteVersion))).filter((e) => SNAPSHOT_RE.test(e));
    for (const snapshot of days.sort().reverse()) {
      const file = Bun.file(join(dir, suiteVersion, snapshot, "snapshot.json"));
      if (!(await file.exists())) continue;
      let publishedAt: string | null = null;
      try {
        const parsed = (await file.json()) as { publishedAt?: unknown };
        publishedAt = typeof parsed.publishedAt === "string" ? parsed.publishedAt : null;
      } catch {
        continue;
      }
      versions.push({ suiteVersion, snapshot, publishedAt });
    }
  }
  // Newest publish first across suite versions; a same-day tie goes to the higher suite.
  versions.sort(
    (a, b) =>
      (a.snapshot < b.snapshot ? 1 : a.snapshot > b.snapshot ? -1 : 0) ||
      byVersionDesc(a.suiteVersion, b.suiteVersion),
  );
  return { versions, latest: versions[0]?.suiteVersion ?? null };
}

export async function serveBenchmarkIndex(): Promise<Response> {
  return json(await listBenchmarkVersions());
}

/** `snapshot` omitted = the suite version's newest snapshot (what `/benchmark?v=1.0` shows). */
export async function serveBenchmarkSnapshot(
  version: string,
  snapshot?: string,
): Promise<Response> {
  if (!VERSION_RE.test(version)) return json({ error: "not a suite version" }, 400);
  if (snapshot !== undefined && !SNAPSHOT_RE.test(snapshot)) {
    return json({ error: "not a snapshot date (YYYY-MM-DD)" }, 400);
  }
  const day =
    snapshot ??
    (await listBenchmarkVersions()).versions.find((v) => v.suiteVersion === version)?.snapshot;
  const file = day ? Bun.file(join(benchmarkDir(), version, day, "snapshot.json")) : null;
  if (!file || !(await file.exists())) {
    const what = snapshot ? `${version} ${snapshot}` : version;
    return json({ error: `no published snapshot for ${what}` }, 404);
  }
  return new Response(file, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}
