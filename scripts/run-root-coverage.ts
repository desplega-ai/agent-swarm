import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scrubSecrets } from "../src/utils/secret-scrubber";

type Source = { lines: Map<number, number>; functionsFound: number; functionsHit: number };

export function mergeLcov(reports: readonly string[]): string {
  const sources = new Map<string, Source>();
  for (const contents of reports) {
    let source: Source | undefined;
    for (const line of contents.split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        const path = line.slice(3);
        source = sources.get(path);
        if (!source) {
          source = { lines: new Map(), functionsFound: 0, functionsHit: 0 };
          sources.set(path, source);
        }
      } else if (source && line.startsWith("DA:")) {
        const [number, hits] = line.slice(3).split(",").map(Number);
        source.lines.set(number!, (source.lines.get(number!) ?? 0) + hits!);
      } else if (source && line.startsWith("FNF:")) {
        source.functionsFound = Math.max(source.functionsFound, Number(line.slice(4)));
      } else if (source && line.startsWith("FNH:")) {
        // Keep the maximum as a conservative lower bound: Bun emits no FN/FNDA
        // identities, so exact function-hit merging across processes is impossible.
        source.functionsHit = Math.max(source.functionsHit, Number(line.slice(4)));
      } else if (line === "end_of_record") {
        source = undefined;
      }
    }
  }
  const records = [...sources.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, source]) => {
      const lines = [...source.lines.entries()].sort(([a], [b]) => a - b);
      return [
        "TN:",
        `SF:${path}`,
        `FNF:${source.functionsFound}`,
        `FNH:${source.functionsHit}`,
        ...lines.map(([number, hits]) => `DA:${number},${hits}`),
        `LF:${lines.length}`,
        `LH:${lines.filter(([, hits]) => hits > 0).length}`,
        "end_of_record",
      ].join("\n");
    });
  return records.length ? `${records.join("\n")}\n` : "";
}

if (import.meta.main) {
  // Bun's --parallel mode does not write LCOV. Run separate serial processes instead.
  const concurrency = Number(process.env.COVERAGE_CONCURRENCY ?? 4);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("COVERAGE_CONCURRENCY must be a positive integer");
  }
  const configText = await Bun.file("bunfig.coverage.toml").text();
  const config = Bun.TOML.parse(configText) as { test: { pathIgnorePatterns: string[] } };
  const ignored = config.test.pathIgnorePatterns.map((pattern) => new Bun.Glob(pattern));
  const selected = process.argv.slice(2);
  const files = selected.length
    ? selected
    : (await Bun.$`git ls-files -z`.quiet().text())
        .split("\0")
        .filter((path) => /[._](test|spec)\.[cm]?[jt]sx?$/.test(path))
        .filter((path) => !ignored.some((glob) => glob.match(path)))
        .sort();
  if (files.length === 0) throw new Error("No test files selected");

  // Remove only the aggregate, so a failed/empty run cannot upload a stale baseline.
  const output = resolve("coverage/lcov.info");
  await rm(output, { force: true });
  const workDir = await mkdtemp(join(tmpdir(), "root-coverage-"));
  const reports: string[] = [];
  let failed = 0;
  let completed = 0;
  let next = 0;

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, files.length) }, async () => {
        while (next < files.length) {
          const index = next++;
          const file = files[index]!;
          const directory = join(workDir, String(index));
          const configPath = join(workDir, `${index}.toml`);
          // bunfig settings override CLI coverage-dir, so each child needs its own config.
          await Bun.write(
            configPath,
            configText.replace(
              /^coverageDir\s*=.*$/m,
              `coverageDir = ${JSON.stringify(directory)}`,
            ),
          );
          const log = Bun.file(join(workDir, `${index}.log`));
          const logHandle = await open(log.name, "w");
          const child = Bun.spawn(
            [
              "timeout",
              "--signal=KILL",
              "300",
              process.execPath,
              `--config=${configPath}`,
              "test",
              `./${file.replace(/^\.\//, "")}`,
              "--timeout",
              "10000",
            ],
            { stdout: logHandle.fd, stderr: logHandle.fd },
          );
          const status = await child.exited;
          await logHandle.close();
          const report = Bun.file(join(directory, "lcov.info"));
          const hasReport = (await report.exists()) && report.size > 0;
          if (hasReport) reports.push(await report.text());
          if (status !== 0 || !hasReport) {
            failed++;
            console.error(
              `FAIL ${file}: exit ${status}${status === 124 || status === 137 ? " (300 s timeout or killed)" : ""}${!hasReport ? "; missing LCOV" : ""}`,
            );
            console.error(scrubSecrets((await log.text()).split("\n").slice(-80).join("\n")));
          }
          completed++;
          console.log(
            `[${completed}/${files.length}] ${file}: ${status === 0 && hasReport ? "PASS" : "FAIL"}`,
          );
        }
      }),
    );
    const merged = mergeLcov(reports);
    if (!merged) throw new Error("No LCOV records produced");
    const sourceCount = merged.match(/^SF:/gm)!.length;
    await Bun.write(output, merged);
    console.log(
      `Coverage: ${files.length - failed}/${files.length} files passed; ${sourceCount} source records`,
    );
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
