#!/usr/bin/env bun
/**
 * The "Ranking entry" PR check for `community/ranking/<domain>.json`.
 *
 * Each added or changed entry must be `{ "$schema"?, "domain", "claim" }`, named
 * `<domain>.json`, with a claim no other entry uses. The telemetry proxy must
 * then confirm, through `GET /v1/ranking/verify`, that an install sent a valid
 * listing with this exact domain and claim first. The check prints that listing
 * (name, category, description) so the reviewer sees what will be shown. A
 * deleted entry needs no proof.
 *
 * The check is advisory: a Desplega maintainer reviews and merges every entry.
 * It runs on `pull_request` with no secrets (`.github/workflows/ranking-entry.yml`).
 *
 * Usage: bun scripts/check-ranking-entry.ts [--base origin/main]
 * Env: RANKING_VERIFY_ORIGIN (default https://proxy.desplega.sh), GITHUB_STEP_SUMMARY.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { normalizeOrgWebsite } from "../src/utils/org-website";

export const RANKING_DIR = "community/ranking";
const ENTRY_PATH = /^community\/ranking\/([^/]+)\.json$/;
const CLAIM = /^rk_[0-9a-f]{32}$/;
const ENTRY_KEYS = new Set(["$schema", "domain", "claim"]);
const DEFAULT_VERIFY_ORIGIN = "https://proxy.desplega.sh";

export interface EntryChange {
  /** `git diff --name-status` letter: A, M or D. */
  status: string;
  path: string;
}

export interface Entry {
  domain: string;
  claim: string;
}

export interface Verification {
  verified: boolean;
  reasons: string[];
  telemetryActive7d?: boolean;
  websiteMatchesDomain?: boolean;
  listing: {
    name: string;
    domain: string;
    category: string;
    subcategory: string | null;
    description: string | null;
    sourceCodeUrl: string | null;
  } | null;
}

export interface CheckResult {
  problems: string[];
  summary: string[];
}

/** Whether a changed path is a ranking entry (not the README or the schema). */
export function isEntryPath(path: string): boolean {
  return ENTRY_PATH.test(path) && basename(path) !== "schema.json";
}

/** Validate one entry file, the same rules the proxy's `ParseEntryFile` applies. */
export function parseEntry(fileName: string, text: string): Entry {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("must be a JSON object");
  }
  const record = data as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ENTRY_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`has unknown keys: ${unknown.join(", ")}`);
  if (record.$schema !== undefined && typeof record.$schema !== "string") {
    throw new Error("$schema must be a string");
  }
  const { domain, claim } = record;
  if (typeof domain !== "string" || normalizeOrgWebsite(domain) !== domain) {
    throw new Error("domain must be a bare lowercase hostname such as example.com");
  }
  if (fileName !== `${domain}.json`) throw new Error(`must be named ${domain}.json`);
  if (typeof claim !== "string" || !CLAIM.test(claim)) {
    throw new Error("claim must be rk_ followed by 32 lowercase hex characters");
  }
  return { domain, claim };
}

export async function verifyEntry(
  entry: Entry,
  origin = DEFAULT_VERIFY_ORIGIN,
  fetchImpl: typeof fetch = fetch,
): Promise<Verification> {
  const params = new URLSearchParams({ domain: entry.domain, claim: entry.claim });
  const response = await fetchImpl(`${origin.replace(/\/+$/, "")}/v1/ranking/verify?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `the proxy answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
  return (await response.json()) as Verification;
}

const cell = (value: string | null | undefined) => (value ? value.replace(/\|/g, "\\|") : "—");

/** Check the changed entries. `readEntry` and `otherEntries` read the PR head. */
export async function checkRankingEntries(options: {
  changes: EntryChange[];
  readEntry: (path: string) => string;
  /** Every entry file in the folder at the PR head, as `[fileName, text]`. */
  allEntries: Array<[string, string]>;
  verify: (entry: Entry) => Promise<Verification>;
}): Promise<CheckResult> {
  const problems: string[] = [];
  const summary: string[] = [];
  const entries = options.changes.filter((change) => isEntryPath(change.path));
  if (entries.length === 0) {
    summary.push("No ranking entry changed.");
    return { problems, summary };
  }

  const claimOwners = new Map<string, string[]>();
  for (const [fileName, text] of options.allEntries) {
    try {
      const entry = parseEntry(fileName, text);
      claimOwners.set(entry.claim, [...(claimOwners.get(entry.claim) ?? []), fileName]);
    } catch {
      // Reported below when the file is part of this PR.
    }
  }

  for (const change of entries) {
    const fileName = basename(change.path);
    if (change.status.startsWith("D")) {
      summary.push(`- Removed \`${fileName}\`.`);
      continue;
    }
    let entry: Entry;
    try {
      entry = parseEntry(fileName, options.readEntry(change.path));
    } catch (error) {
      problems.push(`${change.path} ${(error as Error).message}`);
      continue;
    }
    const owners = claimOwners.get(entry.claim) ?? [];
    if (owners.length > 1) {
      problems.push(
        `${change.path}: the claim is also used by ${owners.filter((f) => f !== fileName).join(", ")}`,
      );
      continue;
    }

    let result: Verification;
    try {
      result = await options.verify(entry);
    } catch (error) {
      problems.push(
        `${change.path}: verification failed (${(error as Error).message}). Re-run the check.`,
      );
      continue;
    }
    if (!result.verified) {
      const reasons = result.reasons.length > 0 ? result.reasons.join(", ") : "not verified";
      problems.push(
        `${change.path}: the proxy did not verify ${entry.domain} (${reasons}). Click Get ranked on the install again, keep telemetry on, and re-run this check.`,
      );
    }
    const listing = result.listing;
    summary.push(
      `### ${entry.domain}: ${result.verified ? "verified" : "not verified"}`,
      "",
      "| Name | Category | Subcategory | Description | Source code |",
      "|---|---|---|---|---|",
      listing
        ? `| ${cell(listing.name)} | ${cell(listing.category)} | ${cell(listing.subcategory)} | ${cell(listing.description)} | ${cell(listing.sourceCodeUrl)} |`
        : "| — | — | — | — | — |",
      "",
      result.reasons.length > 0 ? `Reasons: ${result.reasons.join(", ")}` : "",
    );
  }
  return { problems, summary: summary.filter((line, i, all) => line !== "" || all[i - 1] !== "") };
}

async function changedEntries(base: string): Promise<EntryChange[]> {
  const proc = Bun.spawn(
    ["git", "diff", "--name-status", "--no-renames", `${base}...HEAD`, "--", RANKING_DIR],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git diff against ${base} failed: ${stderr.trim()}`);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", path = ""] = line.split("\t");
      return { status, path };
    });
}

if (import.meta.main) {
  const i = process.argv.indexOf("--base");
  const base = i === -1 ? "origin/main" : (process.argv[i + 1] ?? "origin/main");
  const origin = process.env.RANKING_VERIFY_ORIGIN || DEFAULT_VERIFY_ORIGIN;
  const allEntries: Array<[string, string]> = existsSync(RANKING_DIR)
    ? readdirSync(RANKING_DIR)
        .filter((name) => isEntryPath(`${RANKING_DIR}/${name}`))
        .map((name) => [name, readFileSync(join(RANKING_DIR, name), "utf8")])
    : [];
  const result = await checkRankingEntries({
    changes: await changedEntries(base),
    readEntry: (path) => readFileSync(path, "utf8"),
    allEntries,
    verify: (entry) => verifyEntry(entry, origin),
  });
  const summary = ["## Ranking entry", "", ...result.summary].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (result.problems.length > 0) {
    console.error("\nRanking entry check failed:");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}
