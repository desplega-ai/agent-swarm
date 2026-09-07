import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseFlags } from "./cli.ts";
import type { ArtifactRecord, Summary } from "./ingest-payload.ts";
import {
  buildUploadPlan,
  pickImages,
  type SummaryDirectory,
  type UploadItem,
} from "./publish-plan.ts";

interface Options {
  results: string;
  prefix: string;
  artifactsOut: string;
  imagesOut: string;
  imageCap: number;
  concurrency: number;
  dryRun: boolean;
}

interface ArtifactOutput extends ArtifactRecord {
  dryRun?: true;
}

interface ImageOutput {
  name: string;
  url: string;
  path?: string;
  expiresAt?: string;
}

function parseNonNegativeInteger(value: string | true | undefined, flag: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`--${flag} must be a non-negative integer`);
  }
  return Number(value);
}

function parseArgs(argv: string[]): Options {
  const flags = parseFlags(argv, {
    required: ["results", "prefix", "artifacts-out", "images-out"],
    optional: ["image-cap", "concurrency"],
    booleans: ["dry-run"],
  });
  const concurrency = parseNonNegativeInteger(flags.get("concurrency") ?? "4", "concurrency");
  if (concurrency < 1) throw new Error("--concurrency must be at least 1");
  return {
    results: flags.get("results") as string,
    prefix: flags.get("prefix") as string,
    artifactsOut: flags.get("artifacts-out") as string,
    imagesOut: flags.get("images-out") as string,
    imageCap: parseNonNegativeInteger(flags.get("image-cap") ?? "24", "image-cap"),
    concurrency,
    dryRun: flags.get("dry-run") === true,
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

function readSummaries(directory: string): SummaryDirectory[] {
  if (!statSync(directory).isDirectory()) throw new Error(`${directory} is not a directory`);
  return findSummaryFiles(directory).map((path) => ({
    dir: dirname(path),
    summary: JSON.parse(readFileSync(path, "utf8")) as Summary,
  }));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

function agentFs(args: string[], output = false): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("agent-fs", args, {
      stdio: ["ignore", output ? "pipe" : "ignore", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once("error", () => resolve({ code: null, stdout }));
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const itemIndex = index;
        const item = items[itemIndex];
        index += 1;
        if (item) await task(item, itemIndex);
      }
    }),
  );
}

function artifactOutput(
  item: UploadItem,
  orgId: string | undefined,
  driveId: string | undefined,
  dryRun = false,
): ArtifactOutput {
  return {
    kind: item.kind,
    path: item.remotePath,
    ...(orgId ? { orgId } : {}),
    ...(driveId ? { driveId } : {}),
    specId: item.specId,
    sizeBytes: statSync(item.localPath).size,
    shardIndex: item.shardIndex,
    ...(dryRun ? { dryRun: true as const } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await Promise.all([writeJson(options.artifactsOut, []), writeJson(options.imagesOut, [])]);
  const summaries = readSummaries(options.results);
  const plan = buildUploadPlan(summaries, options.prefix);
  for (const warning of plan.warnings) console.warn(warning);
  const images = pickImages(plan.items, summaries, options.imageCap);

  const orgId = process.env.AGENT_FS_DEFAULT_ORG_ID;
  const driveId = process.env.AGENT_FS_DEFAULT_DRIVE_ID;
  if (options.dryRun) {
    await writeJson(
      options.artifactsOut,
      plan.items.map((item) => artifactOutput(item, orgId, driveId, true)),
    );
    await writeJson(
      options.imagesOut,
      images.map(({ name, item }) => ({ name, url: "", path: item.remotePath })),
    );
    console.log(`Dry run: ${plan.items.length} artifacts planned, ${images.length} images picked.`);
    return;
  }

  const required = [
    "AGENT_FS_API_URL",
    "AGENT_FS_API_KEY",
    "AGENT_FS_DEFAULT_ORG_ID",
    "AGENT_FS_DEFAULT_DRIVE_ID",
  ];
  const missing = required.find((name) => !process.env[name]);
  if (missing) {
    console.log(`${missing} is unavailable. Skipping artifact upload.`);
    return;
  }
  if (!(await commandExists("agent-fs"))) {
    console.log("agent-fs is unavailable. Skipping artifact upload.");
    return;
  }
  if ((await agentFs(["auth", "whoami"])).code !== 0) {
    console.log("agent-fs authentication failed. Skipping artifact upload.");
    return;
  }

  const publishedByIndex: Array<ArtifactOutput | undefined> = new Array(plan.items.length);
  let failedUploads = 0;
  await runPool(plan.items, options.concurrency, async (item, index) => {
    try {
      const result = await agentFs([
        "write",
        item.remotePath,
        "--file",
        item.localPath,
        "-m",
        `ui-e2e ${process.env.GITHUB_SHA ?? "unknown"}`,
      ]);
      if (result.code !== 0) throw new Error(`agent-fs write exited with ${result.code}`);
      publishedByIndex[index] = artifactOutput(item, orgId as string, driveId as string);
    } catch (error) {
      failedUploads += 1;
      console.warn(`Upload failed for ${item.remotePath}: ${String(error)}. Skipping it.`);
    }
  });
  const published = publishedByIndex.filter((item): item is ArtifactOutput => item !== undefined);
  await writeJson(options.artifactsOut, published);
  if (plan.items.length > 0 && published.length === 0) {
    throw new Error(`Every upload failed (${failedUploads}). Check the agent-fs credentials.`);
  }

  const publishedPaths = new Set(published.map((item) => item.path));
  const imageOutput: ImageOutput[] = [];
  for (const { name, item: image } of images) {
    if (!publishedPaths.has(image.remotePath)) continue;
    const signed = await agentFs(
      ["signed-url", image.remotePath, "--json", "--expires-in", "604800"],
      true,
    );
    if (signed.code !== 0) {
      console.warn(`Signed URL creation failed for ${image.remotePath}. Skipping it.`);
      continue;
    }
    try {
      const response = JSON.parse(signed.stdout) as {
        kind?: string;
        url?: string;
        expiresAt?: string;
      };
      if (response.kind === "presigned" && typeof response.url === "string") {
        imageOutput.push({ name, url: response.url, expiresAt: response.expiresAt });
      }
    } catch {
      console.warn(`Invalid signed URL response for ${image.remotePath}. Skipping it.`);
    }
  }
  await writeJson(options.imagesOut, imageOutput);
  console.log(
    `Published ${published.length} artifacts, ${imageOutput.length} images.${
      failedUploads > 0 ? ` ${failedUploads} uploads failed.` : ""
    }`,
  );
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
