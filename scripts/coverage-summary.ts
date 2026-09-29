import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

type LcovRecord = {
  source: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
};

function percent(hit: number, found: number): number {
  return found === 0 ? 0 : Number(((hit / found) * 100).toFixed(2));
}

function sourcePath(rawPath: string): string {
  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  return relative(process.cwd(), absolutePath).split("\\").join("/");
}

function parseLcov(contents: string): LcovRecord[] {
  const records: LcovRecord[] = [];
  let record: LcovRecord | undefined;

  for (const line of contents.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      record = {
        source: sourcePath(line.slice(3)),
        linesFound: 0,
        linesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
      };
    } else if (record && line.startsWith("LF:")) {
      record.linesFound = Number(line.slice(3));
    } else if (record && line.startsWith("LH:")) {
      record.linesHit = Number(line.slice(3));
    } else if (record && line.startsWith("FNF:")) {
      record.functionsFound = Number(line.slice(4));
    } else if (record && line.startsWith("FNH:")) {
      record.functionsHit = Number(line.slice(4));
    } else if (record && line === "end_of_record") {
      if (record.source.startsWith("src/") && record.linesFound > 0) records.push(record);
      record = undefined;
    }
  }

  if (record) throw new Error("LCOV ended before end_of_record");
  if (records.length === 0) throw new Error("LCOV contains no covered root src/ files");

  const seen = new Set<string>();
  for (const item of records) {
    if (seen.has(item.source)) throw new Error(`LCOV has duplicate source record: ${item.source}`);
    seen.add(item.source);
  }

  return records.sort((a, b) => a.source.localeCompare(b.source));
}

const [lcovPath = "coverage/lcov.info", outputPath = "coverage-summary.json"] =
  process.argv.slice(2);
const records = parseLcov(await readFile(lcovPath, "utf8"));
const totalLinesFound = records.reduce((sum, item) => sum + item.linesFound, 0);
const totalLinesHit = records.reduce((sum, item) => sum + item.linesHit, 0);
const totalFunctionsFound = records.reduce((sum, item) => sum + item.functionsFound, 0);
const totalFunctionsHit = records.reduce((sum, item) => sum + item.functionsHit, 0);
const sha =
  process.env.GITHUB_SHA?.trim() ||
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const summary = {
  sha,
  date: new Date().toISOString().slice(0, 10),
  totalLinesPercent: percent(totalLinesHit, totalLinesFound),
  totalFunctionsPercent: percent(totalFunctionsHit, totalFunctionsFound),
  files: records.map((item) => ({
    path: item.source,
    linesPercent: percent(item.linesHit, item.linesFound),
  })),
};

await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...summary, files: summary.files.length })}\n`);
