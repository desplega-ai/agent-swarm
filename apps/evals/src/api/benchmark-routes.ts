/**
 * Public, read-only benchmark endpoints (swarm-evals plan v2, Phase 10). The
 * ONLY `/api/*` routes that skip EVALS_API_KEY: they serve the frozen snapshots
 * `bun src/cli.ts publish` wrote to disk, never live data, so nothing here reads
 * the DB. A version directory without `snapshot.json` is not listed.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
/** Where snapshots live (`apps/evals/benchmark/<version>/`); override: EVALS_BENCHMARK_DIR. */
export const DEFAULT_BENCHMARK_DIR = join(import.meta.dir, "../../benchmark");

export function benchmarkDir(): string {
  return process.env.EVALS_BENCHMARK_DIR || DEFAULT_BENCHMARK_DIR;
}

const VERSION_RE = /^[0-9]+\.[0-9]+$/;

export interface BenchmarkVersion {
  suiteVersion: string;
  publishedAt: string | null;
}

export interface BenchmarkIndex {
  /** Newest first. Empty until a snapshot is published. */
  versions: BenchmarkVersion[];
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

export async function listBenchmarkVersions(dir = benchmarkDir()): Promise<BenchmarkIndex> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { versions: [], latest: null };
  }
  const versions: BenchmarkVersion[] = [];
  for (const name of entries.filter((e) => VERSION_RE.test(e)).sort(byVersionDesc)) {
    const file = Bun.file(join(dir, name, "snapshot.json"));
    if (!(await file.exists())) continue;
    let publishedAt: string | null = null;
    try {
      const parsed = (await file.json()) as { publishedAt?: unknown };
      publishedAt = typeof parsed.publishedAt === "string" ? parsed.publishedAt : null;
    } catch {
      continue;
    }
    versions.push({ suiteVersion: name, publishedAt });
  }
  return { versions, latest: versions[0]?.suiteVersion ?? null };
}

export async function serveBenchmarkIndex(): Promise<Response> {
  return json(await listBenchmarkVersions());
}

export async function serveBenchmarkSnapshot(version: string): Promise<Response> {
  if (!VERSION_RE.test(version)) return json({ error: "not a suite version" }, 400);
  const file = Bun.file(join(benchmarkDir(), version, "snapshot.json"));
  if (!(await file.exists())) return json({ error: `no published snapshot for ${version}` }, 404);
  return new Response(file, {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
  });
}
