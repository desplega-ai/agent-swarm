#!/usr/bin/env bun
/**
 * Bump every agent-fs version pin in the repo in one go.
 *
 *   bun run bump:agent-fs            # newest stable tag on GHCR
 *   bun run bump:agent-fs 0.13.3     # explicit version (leading "v" accepted)
 *
 * Before touching any file the target version is checked against the three
 * places the worker image and the chart pull it from: the GHCR image manifest,
 * the npm package, and the skill file at the git tag. A missing pin location
 * (layout drift) fails loudly rather than leaving a partial bump behind.
 */

import {
  AGENT_FS_HELM_TAG_PATTERN,
  AGENT_FS_IMAGE,
  AGENT_FS_NPM_PACKAGE,
  AGENT_FS_REPO,
  AGENT_FS_SKILL_PATH,
  checkAgentFsImageManifest,
  fetchWithRetry,
  resolveLatestAgentFsImage,
  stableVersionParts,
} from "./agent-fs-version-utils";

type Pin = {
  path: string;
  /** Group 1 = prefix kept verbatim, group 2 = the version to rewrite. */
  pattern: RegExp;
};

const COMPOSE_IMAGE_PATTERN = new RegExp(`(ghcr\\.io/${AGENT_FS_IMAGE}:)(\\S+)`, "g");

const PINS: Pin[] = [
  { path: "Dockerfile.worker", pattern: /^(ARG AGENT_FS_VERSION=)(\S+)$/m },
  { path: "docker-compose.local.yml", pattern: COMPOSE_IMAGE_PATTERN },
  { path: "docker-compose.example.yml", pattern: COMPOSE_IMAGE_PATTERN },
  { path: "docker-compose.scripts-only.yml", pattern: COMPOSE_IMAGE_PATTERN },
  { path: "charts/agent-swarm/values.yaml", pattern: AGENT_FS_HELM_TAG_PATTERN },
  { path: "charts/agent-swarm/README.md", pattern: AGENT_FS_HELM_TAG_PATTERN },
  {
    path: "docs-site/content/docs/(documentation)/guides/agent-fs-co-deployment.mdx",
    pattern: AGENT_FS_HELM_TAG_PATTERN,
  },
];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function normalizeVersion(raw: string): string {
  const version = raw.replace(/^v/, "");
  if (!stableVersionParts(version)) {
    fail(`Expected a stable semver version like 0.13.3, got "${raw}".`);
  }
  return version;
}

async function resolveTarget(requested: string | undefined): Promise<string> {
  if (!requested) {
    const latest = await resolveLatestAgentFsImage();
    console.log(`Latest GHCR tag: ${latest.tag} (manifest HTTP ${latest.manifestStatus})`);
    return latest.tag;
  }
  const version = normalizeVersion(requested);
  const manifestStatus = await checkAgentFsImageManifest(version);
  if (manifestStatus !== 200) {
    fail(`GHCR has no image ${AGENT_FS_IMAGE}:${version} (manifest HTTP ${manifestStatus}).`);
  }
  console.log(`GHCR image ${AGENT_FS_IMAGE}:${version} exists (manifest HTTP ${manifestStatus})`);
  return version;
}

async function preflight(version: string): Promise<void> {
  const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(AGENT_FS_NPM_PACKAGE)}/${version}`;
  const npmResponse = await fetchWithRetry(npmUrl);
  await npmResponse.body?.cancel();
  if (npmResponse.status !== 200) {
    fail(`npm has no ${AGENT_FS_NPM_PACKAGE}@${version} (HTTP ${npmResponse.status}).`);
  }
  console.log(`npm package ${AGENT_FS_NPM_PACKAGE}@${version} exists`);

  const skillUrl = `https://raw.githubusercontent.com/${AGENT_FS_REPO}/v${version}/${AGENT_FS_SKILL_PATH}`;
  const skillResponse = await fetchWithRetry(skillUrl, { method: "HEAD" });
  await skillResponse.body?.cancel();
  if (skillResponse.status !== 200) {
    fail(
      `Tag v${version} of ${AGENT_FS_REPO} has no ${AGENT_FS_SKILL_PATH} (HTTP ${skillResponse.status}).`,
    );
  }
  console.log(`Skill file ${AGENT_FS_SKILL_PATH} exists at v${version}`);
}

function currentVersions(text: string, pattern: RegExp): string[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].map((match) => match[2] ?? "");
}

async function applyPins(version: string): Promise<void> {
  const rendered: string[] = [];
  for (const pin of PINS) {
    const file = Bun.file(pin.path);
    if (!(await file.exists()))
      fail(`${pin.path} not found; update PINS in scripts/bump-agent-fs.ts.`);
    const original = await file.text();
    const before = currentVersions(original, pin.pattern);
    if (before.length === 0) {
      fail(
        `${pin.path} has no agent-fs pin matching the expected layout; update PINS in scripts/bump-agent-fs.ts.`,
      );
    }
    const updated = original.replace(pin.pattern, `$1${version}`);
    const after = currentVersions(updated, pin.pattern);
    const stale = after.filter((found) => found !== version);
    if (stale.length > 0) {
      fail(
        `${pin.path} still carries ${stale.join(", ")} after rewrite; the pin pattern needs fixing.`,
      );
    }
    if (updated !== original) await Bun.write(pin.path, updated);
    const from = [...new Set(before)].join(", ");
    rendered.push(
      `${updated === original ? "unchanged" : "updated  "}  ${pin.path}  (${from} -> ${version})`,
    );
  }
  console.log(rendered.join("\n"));
}

const args = process.argv.slice(2);
const requested = args.find((arg) => !arg.startsWith("--"));

const target = await resolveTarget(requested);
await preflight(target);
await applyPins(target);
console.log(`agent-fs pins now at ${target}. Review with: git diff`);
