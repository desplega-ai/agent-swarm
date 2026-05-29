#!/usr/bin/env bun

/**
 * prepare-release — regenerate everything that derives from package.json's version.
 *
 * Run this after bumping the `version` field in package.json, then commit the
 * regenerated files alongside the bump. These are the artifacts CI gates on:
 *
 *   - sync-chart-version → charts/agent-swarm/Chart.yaml (helm-publish + docker-and-deploy)
 *   - docs:openapi       → openapi.json + docs-site/content/docs/api-reference/** (merge-gate)
 *
 * Usage: bun run prepare-release
 */

import { $ } from "bun";

type Step = {
  name: string;
  /** Args passed to `bun run <...>`. */
  run: string[];
};

const STEPS: Step[] = [
  { name: "Sync Helm chart version", run: ["sync-chart-version"] },
  { name: "Regenerate OpenAPI spec + API reference docs", run: ["docs:openapi"] },
];

/** Paths touched by the steps above — surfaced at the end so you know what to commit. */
const GENERATED_PATHS = [
  "charts/agent-swarm/Chart.yaml",
  "openapi.json",
  "docs-site/content/docs/api-reference",
];

async function main(): Promise<void> {
  const version = ((await Bun.file("package.json").json()) as { version: string }).version;
  console.log(`\nPreparing release artifacts for version ${version}\n`);

  for (const [i, step] of STEPS.entries()) {
    console.log(`[${i + 1}/${STEPS.length}] ${step.name}`);
    await $`bun run ${step.run}`;
    console.log();
  }

  console.log("Changed files to review and commit:");
  await $`git status --short -- ${GENERATED_PATHS}`;
  console.log(`\nDone. Commit the changes above together with the version bump.`);
}

await main();
