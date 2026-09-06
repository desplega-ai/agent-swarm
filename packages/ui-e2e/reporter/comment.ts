import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface SummaryResult {
  specId: string;
  title: string;
  status: string;
  durationMs: number;
  retry: number;
  error?: string;
}

interface SummaryFile {
  results?: SummaryResult[];
}

interface ImageEntry {
  name: string;
  url: string;
}

interface Options {
  summaries: string;
  images: string;
  runUrl: string;
  reportArtifact: string;
  out: string;
}

interface FinalResult {
  result: SummaryResult;
  retries: number;
  displayStatus: string;
}

const MAX_COMMENT_LENGTH = 59_999;
const STATUS_ORDER = new Map([
  ["failed", 0],
  ["timedOut", 1],
  ["interrupted", 2],
  ["flaky", 3],
  ["skipped", 4],
  ["passed", 5],
]);

function parseArgs(argv: string[]): Options {
  const required = ["summaries", "images", "run-url", "report-artifact", "out"];
  if (argv.length !== required.length * 2) {
    throw new Error("Expected five option and value pairs");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "end of arguments"}`);
    }
    values.set(key.slice(2), value);
  }

  for (const key of required) {
    if (!values.get(key)) throw new Error(`Missing required argument --${key}`);
  }
  if (
    values.size !== required.length ||
    [...values.keys()].some((key) => !required.includes(key))
  ) {
    throw new Error("Unknown or duplicate arguments were provided");
  }

  return {
    summaries: values.get("summaries")!,
    images: values.get("images")!,
    runUrl: values.get("run-url")!,
    reportArtifact: values.get("report-artifact")!,
    out: values.get("out")!,
  };
}

function findSummaryFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findSummaryFiles(path));
    else if (entry.isFile() && entry.name === "summary.json") files.push(path);
  }
  return files.sort();
}

function readResults(directory: string): SummaryResult[] {
  if (!statSync(directory).isDirectory()) throw new Error(`${directory} is not a directory`);
  const results: SummaryResult[] = [];
  for (const file of findSummaryFiles(directory)) {
    try {
      const summary = JSON.parse(readFileSync(file, "utf8")) as SummaryFile;
      if (Array.isArray(summary.results)) results.push(...summary.results);
    } catch (error) {
      console.warn(`Skipping unreadable summary ${file}: ${String(error)}`);
    }
  }
  return results;
}

function readImages(path: string): ImageEntry[] {
  try {
    const content = readFileSync(path, "utf8").trim();
    if (!content) return [];
    const images = JSON.parse(content) as unknown;
    if (!Array.isArray(images)) return [];
    return images.filter(
      (image): image is ImageEntry =>
        typeof image === "object" &&
        image !== null &&
        typeof image.name === "string" &&
        typeof image.url === "string",
    );
  } catch {
    return [];
  }
}

function finalResults(results: SummaryResult[]): FinalResult[] {
  const bySpec = new Map<string, { result: SummaryResult; retries: number }>();
  for (const result of results) {
    if (!result.specId) continue;
    const previous = bySpec.get(result.specId);
    bySpec.set(result.specId, {
      result,
      retries: Math.max(previous?.retries ?? 0, result.retry ?? 0),
    });
  }

  return [...bySpec.values()]
    .map(({ result, retries }) => ({
      result,
      retries,
      displayStatus: result.status === "passed" && retries > 0 ? "flaky" : result.status,
    }))
    .sort((left, right) => {
      const status =
        (STATUS_ORDER.get(left.displayStatus) ?? 99) -
        (STATUS_ORDER.get(right.displayStatus) ?? 99);
      return status || left.result.specId.localeCompare(right.result.specId);
    });
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(1)} s`;
}

const ATTENTION = new Set(["failed", "timedOut", "interrupted", "flaky"]);
const COUNT_ORDER = ["failed", "timedOut", "interrupted", "flaky", "passed", "skipped"] as const;

// One project only, so the leading project segment carries no information in the table.
function specLabel(specId: string): string {
  return specId.replace(/^[^>]+ > /, "");
}

function tableRows(results: FinalResult[]): string[] {
  return [
    "| spec | status | duration | retries |",
    "|---|---:|---:|---:|",
    ...results.map(
      ({ result, retries, displayStatus }) =>
        `| ${escapeTable(specLabel(result.specId))} | ${displayStatus} | ${formatDuration(result.durationMs)} | ${retries} |`,
    ),
  ];
}

function renderComment(
  results: FinalResult[],
  images: ImageEntry[],
  options: Options,
  collapsedLimit: number,
): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    counts.set(result.displayStatus, (counts.get(result.displayStatus) ?? 0) + 1);
  }
  const headline = COUNT_ORDER.filter((status) => counts.get(status))
    .map((status) => `${counts.get(status)} ${status}`)
    .join(", ");

  // Only rows that need attention stay visible. Passed and skipped rows are collapsed.
  const attention = results.filter((result) => ATTENTION.has(result.displayStatus));
  const rest = results.filter((result) => !ATTENTION.has(result.displayStatus));
  const lines = ["<!-- ui-e2e -->", "## UI E2E", "", `**${headline || "no results"}**`];

  if (attention.length > 0) lines.push("", ...tableRows(attention));

  for (const { result, displayStatus } of attention) {
    if (!result.error || displayStatus === "flaky") continue;
    lines.push(
      "",
      "<details>",
      `<summary>${escapeHtml(displayStatus)}: ${escapeHtml(result.specId)}</summary>`,
      "",
      `<pre>${escapeHtml(result.error.slice(0, 2_000))}</pre>`,
      "</details>",
    );
  }

  if (rest.length > 0) {
    const visible = rest.slice(0, collapsedLimit);
    const omitted = rest.length - visible.length;
    lines.push(
      "",
      "<details>",
      `<summary>${rest.length} passed or skipped</summary>`,
      "",
      ...tableRows(visible),
    );
    if (omitted > 0) lines.push("", `${omitted} rows omitted.`);
    lines.push("</details>");
  }

  if (images.length > 0) {
    lines.push("", "### Images", "");
    for (const image of images) {
      lines.push(`![${escapeTable(image.name)}](${image.url})`);
    }
  }

  lines.push(
    "",
    `Run: [GitHub Actions](${options.runUrl}) | HTML report artifact: \`${escapeTable(options.reportArtifact)}\``,
    "",
  );
  return lines.join("\n");
}

function buildComment(results: FinalResult[], images: ImageEntry[], options: Options): string {
  let collapsedLimit = results.filter((result) => !ATTENTION.has(result.displayStatus)).length;
  let body = renderComment(results, images, options, collapsedLimit);
  if (body.length > MAX_COMMENT_LENGTH) body = renderComment(results, [], options, collapsedLimit);
  while (body.length > MAX_COMMENT_LENGTH && collapsedLimit > 0) {
    collapsedLimit -= 1;
    body = renderComment(results, [], options, collapsedLimit);
  }
  if (body.length > MAX_COMMENT_LENGTH) {
    const suffix = "\n\n_Comment truncated to fit the GitHub limit._\n";
    body = `${body.slice(0, MAX_COMMENT_LENGTH - suffix.length)}${suffix}`;
  }
  return body;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const results = finalResults(readResults(options.summaries));
  const images = readImages(options.images);
  const comment = buildComment(results, images, options);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, comment);
}

try {
  main();
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
