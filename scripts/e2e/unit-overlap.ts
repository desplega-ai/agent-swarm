// Unit-test retirement report: which unit test files drive the server over HTTP or MCP, and
// which route operations and MCP tools each one touches. Every route and tool is covered by
// the strict black-box suite, so a file whose only subject is that surface is a candidate to
// retire. The report is a starting list for a human review, never a deletion.
//
//   bun scripts/e2e/unit-overlap.ts            # markdown table on stdout
//   bun scripts/e2e/unit-overlap.ts --json     # machine-readable
//
// Heuristics, on purpose simple: a file is "wire-level" when it spawns src/http.ts, uses the
// MCP client transport, or calls fetch() against /api paths. Route templates are matched
// from string literals; a test that builds paths dynamically is listed with what it names.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const root = `${import.meta.dir}/../..`;
const testsDir = join(root, "src/tests");

type Report = {
  file: string;
  signals: string[];
  routes: string[];
  tools: string[];
  verdict: "candidate" | "keep" | "review";
  reason: string;
};

const KEEP_PATTERNS: Array<[RegExp, string]> = [
  [/migration/i, "migration fixture"],
  [/scrub|secret|redact/i, "secret handling"],
  [/db-client|async-db|seam/i, "db transaction semantics"],
  [/pricing|model-catalog|models-catalog/i, "catalog and pricing math"],
  [/prompt.*render|template.*render/i, "prompt rendering"],
  [/fake-(claude|codex|amp|fx)|routes-e2e|adapter/i, "harness adapter against a fake provider"],
];

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const openapi = (await Bun.file(join(root, "openapi.json")).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const templates = Object.keys(openapi.paths);
  const templateRegexes = templates.map((template) => ({
    template,
    regex: new RegExp(
      `^${template
        .split(/\{[^}]+\}/)
        .map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/\\s'\"`]+")}$`,
    ),
  }));

  const files = (await readdir(testsDir)).filter((name) => name.endsWith(".test.ts")).sort();
  const reports: Report[] = [];
  for (const name of files) {
    const text = await Bun.file(join(testsDir, name)).text();
    const signals: string[] = [];
    if (/src\/http\.ts/.test(text)) signals.push("boots src/http.ts");
    if (/StreamableHTTPClientTransport|\/mcp["'`]/.test(text)) signals.push("MCP client");
    if (/fetch\([^)]*\/api\//.test(text)) signals.push("fetch /api");
    if (signals.length === 0) continue;

    const routes = new Set<string>();
    for (const match of text.matchAll(/["'`](\/(?:api|p|share|site|invite|mcp)[^"'`\s?]*)/g)) {
      const path = match[1] ?? "";
      const hit = templateRegexes.find(({ regex }) => regex.test(path));
      if (hit) routes.add(hit.template);
    }
    const tools = new Set<string>();
    for (const match of text.matchAll(/callTool\(\s*\{?\s*(?:name:\s*)?["']([a-z0-9_-]+)["']/g)) {
      tools.add(match[1] ?? "");
    }
    const keep = KEEP_PATTERNS.find(([pattern]) => pattern.test(name));
    let verdict: Report["verdict"] = "review";
    let reason = "wire-level test; compare its assertions with the scenarios that own these routes";
    if (keep) {
      verdict = "keep";
      reason = keep[1];
    } else if (routes.size + tools.size >= 3) {
      verdict = "candidate";
      reason = "exercises only surfaces the strict suite already proves end to end";
    }
    reports.push({
      file: `src/tests/${name}`,
      signals,
      routes: [...routes].sort(),
      tools: [...tools].sort(),
      verdict,
      reason,
    });
  }

  if (json) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }
  const counts = { candidate: 0, review: 0, keep: 0 };
  for (const report of reports) counts[report.verdict] += 1;
  console.log(
    `# Unit tests that drive the server over the wire: ${reports.length} (${counts.candidate} candidates, ${counts.review} to review, ${counts.keep} keep)\n`,
  );
  console.log("| File | Verdict | Signals | Routes | Tools | Reason |");
  console.log("| --- | --- | --- | ---: | ---: | --- |");
  for (const report of reports) {
    console.log(
      `| ${report.file} | ${report.verdict} | ${report.signals.join(", ")} | ${report.routes.length} | ${report.tools.length} | ${report.reason} |`,
    );
  }
}

await main();
