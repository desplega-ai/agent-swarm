#!/usr/bin/env bun
/**
 * Bump every agent-fs version pin in the repo in one go.
 *
 *   bun run bump:agent-fs            # newest stable tag on GHCR
 *   bun run bump:agent-fs 0.13.3     # explicit version (leading "v" accepted)
 *
 * Before touching any file the target version is checked against the places
 * the worker image, the chart and the scripts runtime pull it from: the GHCR
 * image manifest, the npm packages (CLI and just-bash adapter), and the skill
 * file at the git tag. A missing pin location (layout drift) fails loudly
 * rather than leaving a partial bump behind. After the rewrite `bun install`
 * refreshes bun.lock so the adapter's lock entry matches package.json.
 */

import {
  AGENT_FS_ADAPTER_NPM_PACKAGE,
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
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export const PINS: Pin[] = [
  { path: "Dockerfile.worker", pattern: /^(ARG AGENT_FS_VERSION=)(\S+)$/m },
  {
    path: "src/commands/onboard/agent-fs-version.ts",
    // Quote-safe: COMPOSE_IMAGE_PATTERN's \S+ would also eat the closing quote.
    pattern: /^(export const AGENT_FS_VERSION = ")([^"]+)/m,
  },
  { path: "docker-compose.local.yml", pattern: COMPOSE_IMAGE_PATTERN },
  { path: "docker-compose.example.yml", pattern: COMPOSE_IMAGE_PATTERN },
  { path: "docker-compose.scripts-only.yml", pattern: COMPOSE_IMAGE_PATTERN },
  { path: "charts/agent-swarm/values.yaml", pattern: AGENT_FS_HELM_TAG_PATTERN },
  { path: "charts/agent-swarm/README.md", pattern: AGENT_FS_HELM_TAG_PATTERN },
  {
    path: "docs-site/content/docs/(documentation)/guides/agent-fs-co-deployment.mdx",
    pattern: AGENT_FS_HELM_TAG_PATTERN,
  },
  {
    path: ".github/workflows/ui-e2e.yml",
    pattern: /^([ \t]*npm i -g @desplega\.ai\/agent-fs@)(\S+)$/m,
  },
  {
    path: "charts/agent-swarm/examples/values-all-workers-agent-fs.yaml",
    pattern: AGENT_FS_HELM_TAG_PATTERN,
  },
  {
    path: "package.json",
    pattern: new RegExp(`^(\\s*"${escapeRegExp(AGENT_FS_ADAPTER_NPM_PACKAGE)}": ")([^"]+)`, "m"),
  },
  {
    path: "DEPLOYMENT.md",
    pattern: /^(The bundled agent-fs service uses version )(\S+)(?=\.)/m,
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
  for (const pkg of [AGENT_FS_NPM_PACKAGE, AGENT_FS_ADAPTER_NPM_PACKAGE]) {
    const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/${version}`;
    const npmResponse = await fetchWithRetry(npmUrl);
    await npmResponse.body?.cancel();
    if (npmResponse.status !== 200) {
      fail(`npm has no ${pkg}@${version} (HTTP ${npmResponse.status}).`);
    }
    console.log(`npm package ${pkg}@${version} exists`);
  }

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

/**
 * Rewrite every pin under `root` to `version`. Throws on a missing file or a
 * pin that does not match, before or after the rewrite; returns one summary
 * line per pin.
 */
export async function applyPins(version: string, root = "."): Promise<string[]> {
  const rendered: string[] = [];
  for (const pin of PINS) {
    const file = Bun.file(`${root}/${pin.path}`);
    if (!(await file.exists()))
      throw new Error(`${pin.path} not found; update PINS in scripts/bump-agent-fs.ts.`);
    const original = await file.text();
    const before = currentVersions(original, pin.pattern);
    if (before.length === 0) {
      throw new Error(
        `${pin.path} has no agent-fs pin matching the expected layout; update PINS in scripts/bump-agent-fs.ts.`,
      );
    }
    const updated = original.replace(pin.pattern, `$1${version}`);
    const after = currentVersions(updated, pin.pattern);
    const stale = after.filter((found) => found !== version);
    if (stale.length > 0) {
      throw new Error(
        `${pin.path} still carries ${stale.join(", ")} after rewrite; the pin pattern needs fixing.`,
      );
    }
    if (updated !== original) await Bun.write(file, updated);
    const from = [...new Set(before)].join(", ");
    rendered.push(
      `${updated === original ? "unchanged" : "updated  "}  ${pin.path}  (${from} -> ${version})`,
    );
  }
  return rendered;
}

/**
 * Throw unless bun.lock resolves the just-bash adapter to `version`. Run after
 * `bun install` so a lockfile that did not follow package.json fails loudly.
 */
export function assertLockfilePinned(lockText: string, version: string): void {
  const resolved = [
    ...lockText.matchAll(
      new RegExp(`"${escapeRegExp(AGENT_FS_ADAPTER_NPM_PACKAGE)}@([^"]+)"`, "g"),
    ),
  ].map((match) => match[1]);
  if (resolved.length === 0) {
    throw new Error(`bun.lock has no ${AGENT_FS_ADAPTER_NPM_PACKAGE} entry.`);
  }
  const stale = resolved.filter((found) => found !== version);
  if (stale.length > 0) {
    throw new Error(
      `bun.lock still resolves ${AGENT_FS_ADAPTER_NPM_PACKAGE}@${stale.join(", ")}; expected ${version}.`,
    );
  }
}

async function refreshLockfile(version: string): Promise<void> {
  const install = Bun.spawn(["bun", "install"], { stdout: "inherit", stderr: "inherit" });
  if ((await install.exited) !== 0) fail("bun install failed; bun.lock was not refreshed.");
  assertLockfilePinned(await Bun.file("bun.lock").text(), version);
  console.log(`bun.lock resolves ${AGENT_FS_ADAPTER_NPM_PACKAGE}@${version}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const requested = args.find((arg) => !arg.startsWith("--"));

  const target = await resolveTarget(requested);
  await preflight(target);
  try {
    console.log((await applyPins(target)).join("\n"));
    await refreshLockfile(target);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(`agent-fs pins now at ${target}. Review with: git diff`);
}
