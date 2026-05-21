#!/usr/bin/env bun
/**
 * storyboard-from-tag.ts — build a release-video storyboard from a git tag range.
 *
 * Collects the merged PRs between two tags and emits a storyboard JSON that
 * drives the SwarmDemo Remotion composition and the release recorder.
 * `demo_script_id` and `vo_line` are left blank for a human / the recorder
 * to fill in.
 *
 * Usage:
 *   bun bin/storyboard-from-tag.ts <newTag> [<oldTag>] [--out <path>] [--repo <owner/name>]
 *
 *   bun bin/storyboard-from-tag.ts v1.81.0
 *       → diff v1.81.0 against the previous tag
 *   bun bin/storyboard-from-tag.ts v1.81.0 v1.80.3
 *       → diff the explicit v1.80.3..v1.81.0 range
 *   bun bin/storyboard-from-tag.ts v1.81.0 --out storyboard.json
 *       → print the storyboard AND write it to storyboard.json
 *
 * The JSON always goes to stdout (pipeable); diagnostics go to stderr.
 */

import { $ } from "bun";

interface Beat {
  title: string;
  prNumber: number;
  prUrl: string;
  demo_script_id: string;
  vo_line: string;
}

interface Storyboard {
  version: string;
  summary: string;
  beats: Beat[];
}

interface GhPr {
  number: number;
  title: string;
  url: string;
}

const USAGE =
  "Usage: bun bin/storyboard-from-tag.ts <newTag> [<oldTag>] [--out <path>] [--repo <owner/name>]";

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

async function run(cmd: ReturnType<typeof $>): Promise<string | null> {
  const res = await cmd.nothrow().quiet();
  if (res.exitCode !== 0) return null;
  return res.text().trim();
}

async function detectRepo(): Promise<string> {
  const url = await run($`git remote get-url origin`);
  const match = url?.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
  return match?.[1] ?? "desplega-ai/agent-swarm";
}

// Best-effort enrichment: a pool of merged PRs from `gh pr list --search`,
// keyed by PR number. Empty if gh is unavailable or unauthenticated — callers
// fall back to the git commit subject + a constructed URL.
async function fetchPrPool(
  repo: string,
  sinceDate: string | null,
): Promise<Map<number, GhPr>> {
  const pool = new Map<number, GhPr>();
  const search = sinceDate ? `merged:>=${sinceDate}` : "is:merged";
  const json = await run(
    $`gh pr list --repo ${repo} --state merged --search ${search} --json number,title,url --limit 300`,
  );
  if (!json) return pool;
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      for (const entry of parsed as GhPr[]) {
        if (typeof entry?.number === "number") pool.set(entry.number, entry);
      }
    }
  } catch {
    // gh produced non-JSON output — fall back to git-only metadata.
  }
  return pool;
}

async function main(): Promise<void> {
  const positional: string[] = [];
  let outPath: string | undefined;
  let repoOverride: string | undefined;

  const args = Bun.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--out" || arg === "-o") {
      outPath = args[++i];
    } else if (arg === "--repo") {
      repoOverride = args[++i];
    } else {
      positional.push(arg);
    }
  }

  const newTag = positional[0];
  if (!newTag) fail("a tag/ref is required");
  let oldTag = positional[1];

  // Single ref → diff against the previous tag.
  if (!oldTag) {
    const prev = await run($`git describe --tags --abbrev=0 ${`${newTag}^`}`);
    if (!prev) {
      fail(
        `could not resolve a previous tag for ${newTag} — pass it explicitly: <newTag> <oldTag>`,
      );
    }
    oldTag = prev;
  }

  const repo = repoOverride ?? (await detectRepo());
  const range = `${oldTag}..${newTag}`;

  const log = await run($`git log --pretty=format:%s ${range}`);
  if (log === null) {
    fail(`bad ref range ${range} — are both tags present locally?`);
  }

  const sinceDate = await run($`git log -1 --format=%cs ${oldTag}`);
  const prPool = await fetchPrPool(repo, sinceDate);

  // git log is newest-first; reverse so the video reads in merge order.
  const subjects = log
    ? log.split("\n").filter((line) => line.trim().length > 0)
    : [];
  subjects.reverse();

  const beats: Beat[] = [];
  const seen = new Set<number>();
  for (const subject of subjects) {
    const match = subject.match(/\(#(\d+)\)\s*$/);
    if (!match?.[1]) continue; // skip non-PR commits (version bumps, etc.)
    const prNumber = Number.parseInt(match[1], 10);
    if (seen.has(prNumber)) continue;
    seen.add(prNumber);

    const pr = prPool.get(prNumber);
    const title = pr?.title ?? subject.replace(/\s*\(#\d+\)\s*$/, "").trim();
    const prUrl = pr?.url ?? `https://github.com/${repo}/pull/${prNumber}`;
    beats.push({ title, prNumber, prUrl, demo_script_id: "", vo_line: "" });
  }

  const storyboard: Storyboard = {
    version: newTag,
    summary: `${oldTag} → ${newTag} — ${beats.length} merged ${
      beats.length === 1 ? "PR" : "PRs"
    }. (edit this summary before recording)`,
    beats,
  };

  const json = JSON.stringify(storyboard, null, 2);
  console.log(json);

  console.error(
    `\n${beats.length} beat(s) from ${range} (${repo})${
      prPool.size === 0 ? " — gh enrichment unavailable, used git subjects" : ""
    }`,
  );

  if (outPath) {
    await Bun.write(outPath, `${json}\n`);
    console.error(`wrote ${outPath}`);
  }
}

await main();
