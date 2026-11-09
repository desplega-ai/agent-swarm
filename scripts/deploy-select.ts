#!/usr/bin/env bun
/**
 * Pick the main commit .github/workflows/deploy.yml deploys, and pin its image
 * digests.
 *
 * docker-and-deploy.yml builds on every main push, but builds are superseded
 * per ref, so not every main commit gets images. This walks main's first-parent
 * history newest first and takes the first commit whose api, worker and
 * worker-slim `sha-<short>` images all exist. It stops at the commit `:latest`
 * already runs: reaching it means main has no new built images, so the run
 * skips (no promotion, no Dokploy call, no Slack post). A requested SHA (manual
 * dispatch) skips the walk and must be on main with all three images.
 *
 * Each image tag resolves to a digest once, here. The workflow promotes those
 * digests, so a build rerun that moves a SHA tag mid-deploy cannot mix images.
 *
 * Usage (needs a logged-in `docker buildx` and a full-history main checkout):
 *   API_IMAGE=ghcr.io/o/r WORKER_IMAGE=ghcr.io/o/r-worker bun scripts/deploy-select.ts [sha]
 * Writes action, sha, version, prev_sha, api_digest, worker_digest and
 * slim_digest to $GITHUB_OUTPUT. Regression test: src/tests/deploy-select.test.ts.
 */
import { appendFileSync } from "node:fs";
import { $ } from "bun";

export type Digests = { api: string; worker: string; slim: string };

export type Selection =
  | { action: "deploy"; sha: string; digests: Digests }
  | { action: "skip"; reason: string };

export type SelectInput = {
  /** Main first-parent commits, newest first. */
  commits: string[];
  /** Revision label of the api `:latest` image, or null when it has none. */
  deployedSha: string | null;
  /** Full SHA from a manual dispatch; skips the walk. */
  requestedSha?: string;
  /** Digests of the commit's three images, or null when any is missing. */
  resolve: (sha: string) => Promise<Digests | null>;
};

export async function selectDeploy(input: SelectInput): Promise<Selection> {
  const { commits, deployedSha, requestedSha, resolve } = input;
  if (requestedSha) {
    if (!commits.includes(requestedSha)) throw new Error(`${requestedSha} is not on main`);
    if (requestedSha === deployedSha) {
      return { action: "skip", reason: `${requestedSha} is already deployed` };
    }
    const digests = await resolve(requestedSha);
    if (!digests) throw new Error(`${requestedSha} is missing an api, worker or worker-slim image`);
    return { action: "deploy", sha: requestedSha, digests };
  }
  for (const sha of commits) {
    if (sha === deployedSha) {
      return {
        action: "skip",
        reason: `main has no new built images since ${sha}, already deployed`,
      };
    }
    const digests = await resolve(sha);
    if (digests) return { action: "deploy", sha, digests };
  }
  return {
    action: "skip",
    reason: `none of the last ${commits.length} main commits has all three images`,
  };
}

/** Manifest digest of a tag, or null when the tag does not exist. */
async function digestOf(ref: string): Promise<string | null> {
  const r = await $`docker buildx imagetools inspect ${ref} --format ${"{{json .Manifest}}"}`
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) {
    if (/not found|manifest unknown/i.test(r.stderr.toString())) return null;
    throw new Error(`inspect ${ref} failed: ${r.stderr.toString().trim()}`);
  }
  const digest = JSON.parse(r.stdout.toString()).digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`bad digest for ${ref}: ${digest}`);
  return digest;
}

async function main(): Promise<void> {
  const apiImage = process.env.API_IMAGE;
  const workerImage = process.env.WORKER_IMAGE;
  const out = process.env.GITHUB_OUTPUT;
  if (!apiImage || !workerImage || !out)
    throw new Error("API_IMAGE, WORKER_IMAGE and GITHUB_OUTPUT are required");

  await $`git fetch --no-tags origin main:refs/remotes/origin/main`.quiet();
  // Docs-only commits start no build, so a run of them can sit on top of the last built commit.
  const commits = (await $`git rev-list --first-parent -n 100 origin/main`.text())
    .split("\n")
    .filter(Boolean);

  const requested = process.argv[2]?.trim();
  const requestedSha = requested
    ? (await $`git rev-parse --verify ${`${requested}^{commit}`}`.text()).trim()
    : undefined;
  if (requestedSha && !commits.includes(requestedSha)) {
    // Older than the walk window: still deployable if it is on main.
    const onMain = await $`git merge-base --is-ancestor ${requestedSha} origin/main`
      .nothrow()
      .quiet();
    if (onMain.exitCode !== 0) throw new Error(`${requestedSha} is not on main`);
    commits.push(requestedSha);
  }

  const latest =
    await $`docker buildx imagetools inspect ${`${apiImage}:latest`} --format ${"{{json .Image}}"}`.json();
  const deployedSha: string | null =
    (latest["linux/amd64"] ?? latest)?.config?.Labels?.["org.opencontainers.image.revision"] ||
    null;
  console.log(`Deployed (:latest) revision: ${deployedSha ?? "unknown"}`);

  const selection = await selectDeploy({
    commits,
    deployedSha,
    requestedSha,
    resolve: async (sha) => {
      const tag = `sha-${sha.slice(0, 7)}`;
      const api = await digestOf(`${apiImage}:${tag}`);
      if (!api) return null;
      const worker = await digestOf(`${workerImage}:${tag}`);
      if (!worker) return null;
      const slim = await digestOf(`${workerImage}:${tag}-slim`);
      return slim ? { api, worker, slim } : null;
    },
  });

  const lines = [`action=${selection.action}`, `prev_sha=${deployedSha ?? ""}`];
  if (selection.action === "deploy") {
    const pkg = JSON.parse(await $`git show ${`${selection.sha}:package.json`}`.text());
    lines.push(
      `sha=${selection.sha}`,
      `version=${pkg.version}`,
      `api_digest=${selection.digests.api}`,
      `worker_digest=${selection.digests.worker}`,
      `slim_digest=${selection.digests.slim}`,
    );
    console.log(
      `Deploying ${selection.sha} (v${pkg.version}): ${JSON.stringify(selection.digests)}`,
    );
  } else {
    console.log(`::notice::Skipping deploy: ${selection.reason}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Deploy skipped: ${selection.reason}.\n`);
    }
  }
  appendFileSync(out, `${lines.join("\n")}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
