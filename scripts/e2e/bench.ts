// Compare two `bun run e2e --json` result files: per-group latency and scenario durations.
//
//   bun scripts/e2e/bench.ts /tmp/before.json /tmp/after.json [--md out.md]
//
// Exit code is 0 unless a file is unreadable. The numbers are for a human or a PR
// comment; thresholds belong to whoever reads them, not to this script.
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
  console.error("usage: bun scripts/e2e/bench.ts <before.json> <after.json> [--md <out.md>]");
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mdIndex = args.indexOf("--md");
  const mdPath = mdIndex >= 0 ? args[mdIndex + 1] : undefined;
  const files = args.filter(
    (arg, index) => arg !== "--md" && (mdIndex < 0 || index !== mdIndex + 1),
  );
  if (files.length !== 2 || (mdIndex >= 0 && !mdPath)) usage();
  const [before, after] = await Promise.all([read(files[0]!), read(files[1]!)]);

  const lines: string[] = [];
  lines.push(
    "## E2E benchmark",
    "",
    `before: ${before.startedAt} (${seconds(before.durationMs)}), after: ${after.startedAt} (${seconds(after.durationMs)})`,
    "",
    "| Surface | Before | After |",
    "| --- | ---: | ---: |",
    `| routes covered | ${before.coverage.routes.covered}/${before.coverage.routes.total} | ${after.coverage.routes.covered}/${after.coverage.routes.total} |`,
    `| mcp tools covered | ${before.coverage.mcpTools.covered}/${before.coverage.mcpTools.total} | ${after.coverage.mcpTools.covered}/${after.coverage.mcpTools.total} |`,
    `| node types covered | ${before.coverage.nodeTypes?.covered ?? "n/a"}/${before.coverage.nodeTypes?.total ?? "n/a"} | ${after.coverage.nodeTypes?.covered ?? "n/a"}/${after.coverage.nodeTypes?.total ?? "n/a"} |`,
    "",
  );

  const beforeOverall = before.coverage.latency?.overall;
  const afterOverall = after.coverage.latency?.overall;
  lines.push(
    "| Latency | Before p50 | After p50 | Δ p50 | Before p95 | After p95 | Δ p95 | Calls before / after |",
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

  lines.push("", "| Scenario | Before | After | Δ |", "| --- | ---: | ---: | ---: |");
  const beforeScenarios = new Map(before.scenarios.map((scenario) => [scenario.name, scenario]));
  const afterScenarios = new Map(after.scenarios.map((scenario) => [scenario.name, scenario]));
  for (const name of [...new Set([...beforeScenarios.keys(), ...afterScenarios.keys()])].sort()) {
    const b = beforeScenarios.get(name);
    const a = afterScenarios.get(name);
    lines.push(
      `| ${name} | ${b ? `${seconds(b.durationMs)} ${b.status}` : ""} | ${a ? `${seconds(a.durationMs)} ${a.status}` : ""} | ${delta(b?.durationMs, a?.durationMs)} |`,
    );
  }
  const markdown = `${lines.join("\n")}\n`;
  if (mdPath) await Bun.write(mdPath, markdown);
  console.log(markdown);
}

await main();
