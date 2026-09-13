#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderChart } from "../src/be/seed-scripts/catalog/star-history-renderer.ts";

const DEFAULT_REPOSITORY = "desplega-ai/agent-swarm";
const DEFAULT_OUTPUT_DIRECTORY = "assets";
const API_VERSION = "2022-11-28";

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function githubToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) return token;

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "GitHub authentication is required. Set GITHUB_TOKEN/GH_TOKEN or authenticate the gh CLI.",
    );
  }
}

async function fetchStargazers(repository, token) {
  const stargazers = [];

  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/stargazers?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github.star+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "agent-swarm-star-history-generator",
          "X-GitHub-Api-Version": API_VERSION,
        },
      },
    );

    if (!response.ok) {
      throw new Error(
        `GitHub stargazers request failed (${response.status} ${response.statusText}).`,
      );
    }

    const pageOfStargazers = await response.json();
    if (!Array.isArray(pageOfStargazers)) {
      throw new Error("GitHub returned an unexpected stargazers response.");
    }

    stargazers.push(...pageOfStargazers);
    if (pageOfStargazers.length < 100) break;
  }

  const timestamps = stargazers.map(({ starred_at: starredAt }) => {
    const timestamp = Date.parse(starredAt);
    if (!Number.isFinite(timestamp)) {
      throw new Error(
        "GitHub omitted stargazer timestamps. Check that the authenticated request uses the star+json media type.",
      );
    }
    return timestamp;
  });

  return timestamps.sort((left, right) => left - right);
}

async function main() {
  const repository = readArgument("--repo", process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY);
  const outputDirectory = resolve(readArgument("--output-dir", DEFAULT_OUTPUT_DIRECTORY));
  if (!repository?.includes("/")) {
    throw new Error("Repository must use the owner/name format.");
  }

  const timestamps = await fetchStargazers(repository, githubToken());
  if (timestamps.length === 0) {
    throw new Error(`No stargazers returned for ${repository}.`);
  }

  mkdirSync(outputDirectory, { recursive: true });
  for (const themeName of ["light", "dark"]) {
    writeFileSync(
      resolve(outputDirectory, `star-history-${themeName}.svg`),
      renderChart(repository, timestamps, themeName),
    );
  }

  console.log(
    `Generated light and dark star history charts for ${repository} (${timestamps.length} stars).`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
