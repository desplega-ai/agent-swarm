import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { FullConfig, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

interface SummaryResult {
  specId: string;
  title: string;
  file: string;
  line: number;
  project: string | undefined;
  status: TestResult["status"];
  expectedStatus: TestCase["expectedStatus"];
  durationMs: number;
  retry: number;
  error: string | undefined;
  tags: string[];
  screenshots: Array<{ name: string; path: string }>;
}

class SummaryReporter implements Reporter {
  private readonly results: SummaryResult[] = [];
  private outputDir = resolve(import.meta.dirname, "../test-results");
  private shard: FullConfig["shard"] = null;
  private startedAt = new Date().toISOString();

  onBegin(config: FullConfig): void {
    this.shard = config.shard;
    this.startedAt = new Date().toISOString();
    this.outputDir = config.projects[0]?.outputDir ?? this.outputDir;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const packageRoot = resolve(import.meta.dirname, "..");
    this.results.push({
      specId: test.titlePath().slice(1).join(" > "),
      title: test.title,
      file: relative(packageRoot, test.location.file).split(sep).join("/"),
      line: test.location.line,
      project: test.parent.project()?.name,
      status: result.status,
      expectedStatus: test.expectedStatus,
      durationMs: result.duration,
      retry: result.retry,
      error: result.errors[0]?.message,
      tags: test.tags,
      screenshots: result.attachments
        .filter(
          (attachment): attachment is typeof attachment & { path: string } =>
            attachment.contentType === "image/png" && Boolean(attachment.path),
        )
        .map((attachment) => ({ name: attachment.name, path: attachment.path })),
    });
  }

  async onEnd(result: Parameters<NonNullable<Reporter["onEnd"]>>[0]): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    await writeFile(
      resolve(this.outputDir, "summary.json"),
      `${JSON.stringify(
        {
          shard: this.shard,
          startedAt: this.startedAt,
          finishedAt: new Date().toISOString(),
          status: result.status,
          results: this.results,
        },
        null,
        2,
      )}\n`,
    );
  }

  printsToStdio(): boolean {
    return false;
  }
}

export default SummaryReporter;
