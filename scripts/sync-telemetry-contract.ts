#!/usr/bin/env bun
/**
 * Vendor the telemetry event catalog from the proxy into packages/telemetry-contract.
 *
 * Usage: bun run sync:telemetry-contract <proxy-commit-sha>
 *        bun run check:telemetry-contract
 *
 * The proxy repo (desplega-ai/proxy) is private and this repo is public, so CI
 * cannot fetch it. `sync` pulls the files through the implementer's `gh` auth
 * at one immutable commit and records their sha256 in SOURCE.json. `--check` is
 * offline: it verifies the committed copies against SOURCE.json, so a hand edit
 * or a partial sync fails CI.
 *
 * A catalog change is: proxy PR merged, then `sync:telemetry-contract <sha>`
 * here, then an agent-swarm PR that emits the new event or property.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "telemetry-contract");
const SOURCE_PATH = join(PACKAGE_ROOT, "SOURCE.json");
const PROXY_REPO = "desplega-ai/proxy";
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Vendored file (relative to the package) -> its path in the proxy repo. */
export const VENDORED_FILES: Readonly<Record<string, string>> = {
  "src/types.gen.ts": "contracts/telemetry/generated/types.ts",
  "src/catalog.json": "contracts/telemetry/catalog/events.json",
  "src/EVENTS.md": "contracts/telemetry/catalog/EVENTS.md",
};

export interface ContractSource {
  repo: string;
  commit: string;
  files: Record<string, string>;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function readSource(path = SOURCE_PATH): ContractSource {
  return JSON.parse(readFileSync(path, "utf8")) as ContractSource;
}

/** Problems with the committed copies. An empty list means the contract is intact. */
export function checkContract(packageRoot = PACKAGE_ROOT): string[] {
  const problems: string[] = [];
  const sourcePath = join(packageRoot, "SOURCE.json");
  if (!existsSync(sourcePath)) return [`${sourcePath} is missing; run the sync`];

  let source: ContractSource;
  try {
    source = readSource(sourcePath);
  } catch (err) {
    return [`SOURCE.json is not valid JSON: ${(err as Error).message}`];
  }
  if (source.repo !== PROXY_REPO) problems.push(`SOURCE.json repo must be ${PROXY_REPO}`);
  if (!FULL_SHA.test(source.commit ?? "")) {
    problems.push("SOURCE.json commit must be a full 40-character sha, not a branch or tag");
  }

  for (const file of Object.keys(VENDORED_FILES)) {
    const path = join(packageRoot, file);
    const expected = source.files?.[file];
    if (!expected) {
      problems.push(`SOURCE.json has no sha256 for ${file}`);
      continue;
    }
    if (!existsSync(path)) {
      problems.push(`${file} is missing`);
      continue;
    }
    const actual = sha256(readFileSync(path));
    if (actual !== expected) {
      problems.push(
        `${file} does not match SOURCE.json (expected ${expected.slice(0, 12)}, got ${actual.slice(0, 12)}). Never hand-edit it; run \`bun run sync:telemetry-contract <sha>\`.`,
      );
    }
  }
  for (const file of Object.keys(source.files ?? {})) {
    if (!(file in VENDORED_FILES)) problems.push(`SOURCE.json lists unknown file ${file}`);
  }
  return problems;
}

async function fetchProxyFile(commit: string, path: string): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      "gh",
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${PROXY_REPO}/contents/${path}?ref=${commit}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `gh api failed for ${path}@${commit.slice(0, 8)} (${stderr.trim() || `exit ${code}`}). ` +
        `The proxy is private: run \`gh auth status\` with an account that can read ${PROXY_REPO}.`,
    );
  }
  return new Uint8Array(stdout);
}

async function sync(commit: string): Promise<void> {
  if (!FULL_SHA.test(commit)) {
    throw new Error(`Pass a full 40-character proxy commit sha (got "${commit}")`);
  }
  const files: Record<string, string> = {};
  const fetched: Array<[string, Uint8Array]> = [];
  for (const [file, proxyPath] of Object.entries(VENDORED_FILES)) {
    const data = await fetchProxyFile(commit, proxyPath);
    if (data.byteLength === 0) throw new Error(`${proxyPath}@${commit.slice(0, 8)} is empty`);
    fetched.push([file, data]);
    files[file] = sha256(data);
  }
  // Write only after every file arrived, so a failed fetch leaves the tree as it was.
  for (const [file, data] of fetched) writeFileSync(join(PACKAGE_ROOT, file), data);
  const source: ContractSource = { repo: PROXY_REPO, commit, files };
  writeFileSync(SOURCE_PATH, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`Vendored ${Object.keys(files).length} files from ${PROXY_REPO}@${commit}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    const problems = checkContract();
    if (problems.length > 0) {
      console.error("Vendored telemetry contract check failed:");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(`Vendored telemetry contract intact (${readSource().commit.slice(0, 8)}).`);
  } else {
    const commit = args.find((arg) => !arg.startsWith("-"));
    if (!commit) {
      console.error("Usage: bun run sync:telemetry-contract <proxy-commit-sha>");
      process.exit(2);
    }
    await sync(commit);
  }
}
