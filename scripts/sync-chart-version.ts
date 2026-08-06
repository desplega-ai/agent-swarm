#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const PACKAGE_JSON = "package.json";
const CHART_YAML = "charts/agent-swarm/Chart.yaml";
const CHART_VALUES_YAML = "charts/agent-swarm/values.yaml";
const AGENT_FS_IMAGE = "desplega-ai/agent-fs";
const GHCR_TOKEN_URL = `https://ghcr.io/token?scope=${encodeURIComponent(`repository:${AGENT_FS_IMAGE}:pull`)}&service=ghcr.io`;
const GHCR_TAGS_URL = `https://ghcr.io/v2/${AGENT_FS_IMAGE}/tags/list?n=1000`;
const OCI_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type ChartVersions = {
  version: string;
  appVersion: string;
};

function stableVersionParts(value: string): [number, number, number] | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareStableVersions(left: string, right: string): number {
  const a = stableVersionParts(left);
  const b = stableVersionParts(right);
  if (!a || !b) throw new Error(`Cannot compare non-stable image tags: ${left}, ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function fetchGhcr(input: string, init: RequestInit = {}): Promise<Response> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maxAttempts) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`GHCR request failed after ${maxAttempts} attempts: ${input}`, {
          cause: error,
        });
      }
    }
  }
  throw new Error(`GHCR request exhausted retries: ${input}`);
}

async function resolveLatestAgentFsImage(): Promise<{ tag: string; manifestStatus: number }> {
  const tokenResponse = await fetchGhcr(GHCR_TOKEN_URL);
  if (!tokenResponse.ok) {
    throw new Error(`GHCR token request failed with HTTP ${tokenResponse.status}`);
  }
  const tokenPayload = (await tokenResponse.json()) as { token?: unknown };
  if (typeof tokenPayload.token !== "string" || tokenPayload.token.length === 0) {
    throw new Error("GHCR token response did not include a token");
  }

  const headers = { Authorization: `Bearer ${tokenPayload.token}` };
  const tagsResponse = await fetchGhcr(GHCR_TAGS_URL, { headers });
  if (!tagsResponse.ok) {
    throw new Error(`GHCR tag-list request failed with HTTP ${tagsResponse.status}`);
  }
  const tagsPayload = (await tagsResponse.json()) as { tags?: unknown };
  const tags = Array.isArray(tagsPayload.tags)
    ? tagsPayload.tags.filter(
        (tag): tag is string => typeof tag === "string" && stableVersionParts(tag) !== undefined,
      )
    : [];
  const tag = tags.sort(compareStableVersions).at(-1);
  if (!tag) throw new Error(`GHCR returned no stable semver tags for ${AGENT_FS_IMAGE}`);

  const manifestResponse = await fetchGhcr(
    `https://ghcr.io/v2/${AGENT_FS_IMAGE}/manifests/${tag}`,
    {
      method: "HEAD",
      headers: { ...headers, Accept: OCI_ACCEPT },
    },
  );
  if (manifestResponse.status !== 200) {
    throw new Error(
      `GHCR manifest check for ${AGENT_FS_IMAGE}:${tag} returned HTTP ${manifestResponse.status}`,
    );
  }
  return { tag, manifestStatus: manifestResponse.status };
}

function readAgentFsImageTag(valuesYaml: string): string {
  const tag = valuesYaml.match(
    /^agentFs:\s*$[\s\S]*?^ {2}image:\s*$[\s\S]*?^ {4}tag:\s*["']?([^\s"']+)["']?\s*$/m,
  )?.[1];
  if (!tag) throw new Error(`${CHART_VALUES_YAML} is missing agentFs.image.tag`);
  return tag;
}

async function checkAgentFsImageTag(): Promise<void> {
  const valuesYaml = await Bun.file(CHART_VALUES_YAML).text();
  const configuredTag = readAgentFsImageTag(valuesYaml);
  const latest = await resolveLatestAgentFsImage();
  if (configuredTag !== latest.tag) {
    console.error(
      [
        `${CHART_VALUES_YAML} has a stale agentFs.image.tag.`,
        `Expected ${latest.tag} (GHCR manifest HTTP ${latest.manifestStatus}), but found ${configuredTag}.`,
        "Update the chart, README, and Compose agent-fs image pins together.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(
    `${CHART_VALUES_YAML} agentFs.image.tag matches GHCR ${latest.tag} (manifest HTTP ${latest.manifestStatus})`,
  );
}

async function readPackageVersionAsync(): Promise<string> {
  const packageJson = (await Bun.file(PACKAGE_JSON).json()) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`${PACKAGE_JSON} is missing a string version field`);
  }
  return packageJson.version;
}

function readChartVersions(chartYaml: string): ChartVersions {
  const version = chartYaml.match(/^version:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  const appVersion = chartYaml.match(/^appVersion:\s*"?([^"\n]+)"?\s*$/m)?.[1];
  if (!version || !appVersion) {
    throw new Error(`${CHART_YAML} must contain version and appVersion fields`);
  }
  return { version, appVersion };
}

async function syncChartVersion(): Promise<void> {
  const packageVersion = await readPackageVersionAsync();
  const original = await Bun.file(CHART_YAML).text();
  readChartVersions(original);

  const updated = original
    .replace(/^version:\s*.*$/m, `version: ${packageVersion}`)
    .replace(/^appVersion:\s*.*$/m, `appVersion: "${packageVersion}"`);

  if (updated !== original) {
    await Bun.write(CHART_YAML, updated);
    console.log(`Synced ${CHART_YAML} to ${packageVersion}`);
  } else {
    console.log(`${CHART_YAML} already matches ${packageVersion}`);
  }
}

async function checkChartVersion(): Promise<void> {
  const packageVersion = await readPackageVersionAsync();
  const chartYaml = await Bun.file(CHART_YAML).text();
  const chart = readChartVersions(chartYaml);

  if (chart.version === packageVersion && chart.appVersion === packageVersion) {
    console.log(`${CHART_YAML} matches ${PACKAGE_JSON} version ${packageVersion}`);
    return;
  }

  console.error(
    [
      `${CHART_YAML} is out of sync with ${PACKAGE_JSON}.`,
      `Expected version=${packageVersion} and appVersion="${packageVersion}", but found version=${chart.version} and appVersion="${chart.appVersion}".`,
      "Run `bun run sync-chart-version` and commit the result.",
    ].join("\n"),
  );
  process.exit(1);
}

function gitShow(ref: string, path: string): string | null {
  const result = spawnSync("git", ["show", `${ref}:${path}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function getBaseRef(args: string[]): string {
  const baseArg = args.find((arg) => arg.startsWith("--base="));
  if (baseArg) return baseArg.slice("--base=".length);
  if (process.env.CHART_VERSION_BASE) return process.env.CHART_VERSION_BASE;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  return "origin/main";
}

async function checkIfPackageVersionChanged(args: string[]): Promise<void> {
  const baseRef = getBaseRef(args);
  const oldPackageJson = gitShow(baseRef, PACKAGE_JSON);
  if (!oldPackageJson) {
    console.log(`Could not read ${PACKAGE_JSON} at ${baseRef}; checking chart version directly.`);
    await checkChartVersion();
    await checkAgentFsImageTag();
    return;
  }

  const oldVersion = (JSON.parse(oldPackageJson) as { version?: unknown }).version;
  const newVersion = await readPackageVersionAsync();
  if (oldVersion === newVersion) {
    console.log(`${PACKAGE_JSON} version unchanged (${newVersion}); chart version guard skipped.`);
    await checkAgentFsImageTag();
    return;
  }

  console.log(`${PACKAGE_JSON} version changed: ${oldVersion} -> ${newVersion}`);
  await checkChartVersion();
  await checkAgentFsImageTag();
}

const args = process.argv.slice(2);

if (args.includes("--check-if-package-version-changed")) {
  await checkIfPackageVersionChanged(args);
} else if (args.includes("--check")) {
  await checkChartVersion();
  await checkAgentFsImageTag();
} else {
  await syncChartVersion();
}
