#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

const PACKAGE_JSON = "package.json";
const CHART_YAML = "charts/agent-swarm/Chart.yaml";

type ChartVersions = {
  version: string;
  appVersion: string;
};

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
    return;
  }

  const oldVersion = (JSON.parse(oldPackageJson) as { version?: unknown }).version;
  const newVersion = await readPackageVersionAsync();
  if (oldVersion === newVersion) {
    console.log(`${PACKAGE_JSON} version unchanged (${newVersion}); chart version guard skipped.`);
    return;
  }

  console.log(`${PACKAGE_JSON} version changed: ${oldVersion} -> ${newVersion}`);
  await checkChartVersion();
}

const args = process.argv.slice(2);

if (args.includes("--check-if-package-version-changed")) {
  await checkIfPackageVersionChanged(args);
} else if (args.includes("--check")) {
  await checkChartVersion();
} else {
  await syncChartVersion();
}
