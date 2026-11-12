import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFlags } from "./cli.ts";
import type { CoverageSummary } from "./ingest-payload.ts";

// Merges the per-shard lcov files into one dashboard coverage summary: a line counts as
// covered when any shard hit it. Writes the tracker's `coverage` block (total and per file)
// and, with --lcov-out, the merged lcov.

type LineHits = Map<string, Map<number, number>>;

function parseLcov(text: string, into: LineHits = new Map()): LineHits {
  let current: Map<number, number> | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      const path = line.slice(3).trim();
      current = into.get(path) ?? new Map();
      into.set(path, current);
    } else if (line.startsWith("DA:") && current) {
      const [lineNo, hits] = line.slice(3).split(",");
      const number = Number(lineNo);
      if (!Number.isFinite(number)) continue;
      current.set(number, (current.get(number) ?? 0) + (Number(hits) || 0));
    } else if (line.startsWith("end_of_record")) {
      current = undefined;
    }
  }
  return into;
}

function summarize(lines: LineHits): CoverageSummary {
  const files = [...lines]
    .map(([path, hits]) => ({
      path,
      covered: [...hits.values()].filter((count) => count > 0).length,
      total: hits.size,
    }))
    .filter((file) => file.total > 0)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    total: {
      covered: files.reduce((sum, file) => sum + file.covered, 0),
      total: files.reduce((sum, file) => sum + file.total, 0),
    },
    files,
  };
}

function toLcov(lines: LineHits): string {
  const records: string[] = [];
  for (const [path, hits] of [...lines].sort(([left], [right]) => left.localeCompare(right))) {
    const sorted = [...hits].sort(([left], [right]) => left - right);
    records.push(
      `SF:${path}`,
      ...sorted.map(([line, count]) => `DA:${line},${count}`),
      `LF:${sorted.length}`,
      `LH:${sorted.filter(([, count]) => count > 0).length}`,
      "end_of_record",
    );
  }
  return `${records.join("\n")}\n`;
}

function lcovFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".info"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function main(): void {
  const values = parseFlags(process.argv.slice(2), {
    required: ["lcov-dir", "out"],
    optional: ["lcov-out"],
  });
  const lcovDir = values.get("lcov-dir") as string;
  const out = values.get("out") as string;
  const lcovOut = values.get("lcov-out") as string | undefined;

  const files = lcovFiles(lcovDir);
  const lines: LineHits = new Map();
  for (const file of files) parseLcov(readFileSync(file, "utf8"), lines);
  const summary = summarize(lines);
  if (summary.files.length === 0) {
    console.log(`coverage: no lcov data under ${lcovDir}`);
    return;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  if (lcovOut) writeFileSync(lcovOut, toLcov(lines));
  const percent = ((summary.total.covered / summary.total.total) * 100).toFixed(1);
  console.log(
    `coverage: ${percent}% of dashboard lines (${summary.total.covered}/${summary.total.total}) in ${summary.files.length} files, from ${files.length} lcov files`,
  );
}

try {
  main();
} catch (error) {
  // Informational: a coverage problem never fails the report job.
  console.log(`::warning::coverage merge failed: ${String(error)}`);
}
