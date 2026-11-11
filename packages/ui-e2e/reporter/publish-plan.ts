import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { type Summary, type SummaryResult, trackerSpecId } from "./ingest-payload.ts";

export interface UploadItem {
  localPath: string;
  remotePath: string;
  kind: "screenshot" | "trace" | "log";
  specId: string | null;
  shardIndex: number;
  attemptRetry: number;
  resultIndex: number;
}

export interface SummaryDirectory {
  dir: string;
  summary: Summary;
}

export interface UploadPlan {
  items: UploadItem[];
  warnings: string[];
}

function slug(value: string): string {
  const output = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return (output || "artifact").slice(0, 120);
}

function attachmentKind(
  attachment: NonNullable<SummaryResult["attachments"]>[number],
): "screenshot" | "trace" | undefined {
  if (attachment.contentType === "image/png") return "screenshot";
  if (attachment.name === "trace" && attachment.contentType === "application/zip") return "trace";
  return undefined;
}

function isInside(base: string, path: string): boolean {
  return path === base || path.startsWith(base + sep);
}

function localPathFor(path: string, directory: string): string | undefined {
  const marker = "/test-results/";
  const markerIndex = path.indexOf(marker);
  const suffix =
    markerIndex >= 0
      ? path.slice(markerIndex + marker.length)
      : path.replace(/^test-results\//, "");
  // Every path, absolute ones included, must stay inside the shard directory. On merge_group the
  // summary comes from the code under test, and a path to any other runner file would be uploaded
  // with the publisher's agent-fs credentials. realpath also stops a symlink that points outside.
  const base = resolve(directory);
  const localPath = resolve(base, suffix);
  if (!isInside(base, localPath) || !existsSync(localPath)) return undefined;
  if (!isInside(realpathSync(base), realpathSync(localPath))) return undefined;
  return localPath;
}

function hasRouteScreenshot(result: SummaryResult, directory: string): boolean {
  return (result.attachments ?? []).some(
    (attachment) =>
      attachment.contentType === "image/png" &&
      attachment.name !== "screenshot" &&
      localPathFor(attachment.path, directory) !== undefined,
  );
}

export function buildUploadPlan(summaries: SummaryDirectory[], basePrefix: string): UploadPlan {
  const items: UploadItem[] = [];
  const warnings: string[] = [];
  let resultIndex = 0;

  for (const { dir, summary } of summaries) {
    const shardIndex = summary.shard?.current ?? 1;
    for (const result of summary.results) {
      const specId = trackerSpecId(result);
      for (const attachment of result.attachments ?? []) {
        const kind = attachmentKind(attachment);
        if (!kind) continue;
        if (
          attachment.name === "screenshot" &&
          result.status === "passed" &&
          hasRouteScreenshot(result, dir)
        ) {
          continue;
        }
        const localPath = localPathFor(attachment.path, dir);
        if (!localPath) {
          warnings.push(`Skipping missing artifact ${attachment.path}`);
          continue;
        }
        const retry = result.retry > 0 ? `-r${result.retry}` : "";
        const extension = kind === "screenshot" ? "png" : "zip";
        items.push({
          localPath,
          remotePath: `${basePrefix}/${shardIndex}/${slug(specId)}${retry}-${slug(attachment.name)}.${extension}`,
          kind,
          specId,
          shardIndex,
          attemptRetry: result.retry,
          resultIndex,
        });
      }
      resultIndex += 1;
    }
    const summaryPath = join(dir, "summary.json");
    if (existsSync(summaryPath)) {
      items.push({
        localPath: summaryPath,
        remotePath: `${basePrefix}/${shardIndex}/summary.json`,
        kind: "log",
        specId: null,
        shardIndex,
        attemptRetry: 0,
        resultIndex: -1,
      });
    }
  }

  return { items, warnings };
}

export function pickImages(
  items: UploadItem[],
  summaries: SummaryDirectory[],
  cap: number,
): Array<{ name: string; item: UploadItem }> {
  const selected: Array<{ name: string; item: UploadItem }> = [];
  // resultIndex is a flat index over every attempt of every summary, so it identifies the attempt.
  const byAttempt = new Map<number, UploadItem[]>();
  for (const item of items) {
    if (item.kind !== "screenshot" || item.resultIndex < 0) continue;
    byAttempt.set(item.resultIndex, [...(byAttempt.get(item.resultIndex) ?? []), item]);
  }

  const indexedResults = summaries
    .flatMap(({ summary }) => summary.results)
    .map((result, index) => ({ result, index }));
  const failures = indexedResults.filter(({ result }) =>
    ["failed", "timedOut"].includes(result.status),
  );
  const smokeRoutes = indexedResults.filter(
    ({ result }) => result.status === "passed" && result.file.endsWith("specs/smoke.spec.ts"),
  );
  for (const { result, index } of [...failures, ...smokeRoutes]) {
    const name = result.status === "passed" ? result.title : `${result.status}: ${result.title}`;
    selected.push(...(byAttempt.get(index) ?? []).map((item) => ({ name, item })));
    if (selected.length >= cap) return selected.slice(0, cap);
  }
  return selected;
}
