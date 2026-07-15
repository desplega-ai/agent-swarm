#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_REPOSITORY = "desplega-ai/agent-swarm";
const DEFAULT_OUTPUT_DIRECTORY = "assets";
const API_VERSION = "2022-11-28";

const themes = {
  light: {
    background: "#ffffff",
    border: "#e5e7eb",
    grid: "#e5e7eb",
    text: "#111827",
    muted: "#6b7280",
    accent: "#f59e0b",
  },
  dark: {
    background: "#0d1117",
    border: "#30363d",
    grid: "#21262d",
    text: "#f0f6fc",
    muted: "#8b949e",
    accent: "#f59e0b",
  },
};

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

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function niceStep(maximum, targetTickCount = 6) {
  const roughStep = maximum / targetTickCount;
  const power = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

function renderChart(repository, timestamps, themeName) {
  const theme = themes[themeName];
  const width = 960;
  const height = 520;
  const margin = { top: 96, right: 34, bottom: 62, left: 76 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const firstStar = timestamps[0];
  const lastStar = timestamps.at(-1);
  const timeRange = Math.max(lastStar - firstStar, 1);
  const yStep = niceStep(timestamps.length);
  const yMaximum = Math.ceil(timestamps.length / yStep) * yStep;
  const plotBottom = margin.top + plotHeight;

  const x = (timestamp) => margin.left + ((timestamp - firstStar) / timeRange) * plotWidth;
  const y = (stars) => margin.top + plotHeight - (stars / yMaximum) * plotHeight;

  const points = timestamps.map((timestamp, index) => ({
    x: x(timestamp),
    y: y(index + 1),
  }));
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const areaPath = `M ${points[0].x.toFixed(1)} ${plotBottom.toFixed(1)} ${linePath.replace(/^M/, "L")} L ${points.at(-1).x.toFixed(1)} ${plotBottom.toFixed(1)} Z`;

  const yTicks = [];
  for (let stars = 0; stars <= yMaximum; stars += yStep) {
    const tickY = y(stars);
    yTicks.push(`
      <line x1="${margin.left}" y1="${tickY.toFixed(1)}" x2="${width - margin.right}" y2="${tickY.toFixed(1)}" stroke="${theme.grid}" />
      <text x="${margin.left - 14}" y="${(tickY + 5).toFixed(1)}" text-anchor="end" fill="${theme.muted}" font-size="13">${stars}</text>`);
  }

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const updatedFormatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const xTicks = Array.from({ length: 7 }, (_, index) => {
    const fraction = index / 6;
    const timestamp = firstStar + timeRange * fraction;
    const tickX = margin.left + plotWidth * fraction;
    return `
      <line x1="${tickX.toFixed(1)}" y1="${margin.top}" x2="${tickX.toFixed(1)}" y2="${plotBottom}" stroke="${theme.grid}" />
      <text x="${tickX.toFixed(1)}" y="${plotBottom + 30}" text-anchor="middle" fill="${theme.muted}" font-size="13">${dateFormatter.format(timestamp)}</text>`;
  });

  const escapedRepository = escapeXml(repository);
  const lastPoint = points.at(-1);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="520" viewBox="0 0 960 520" role="img" aria-labelledby="title description">
  <title id="title">Star history for ${escapedRepository}</title>
  <desc id="description">${timestamps.length} cumulative GitHub stars from ${updatedFormatter.format(firstStar)} through ${updatedFormatter.format(lastStar)}.</desc>
  <defs>
    <linearGradient id="star-area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${theme.accent}" stop-opacity="0.24" />
      <stop offset="100%" stop-color="${theme.accent}" stop-opacity="0.02" />
    </linearGradient>
    <filter id="point-shadow" x="-100%" y="-100%" width="300%" height="300%">
      <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="${theme.accent}" flood-opacity="0.35" />
    </filter>
  </defs>
  <rect x="0.5" y="0.5" width="959" height="519" rx="12" fill="${theme.background}" stroke="${theme.border}" />
  <g font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">
    <text x="${margin.left}" y="43" fill="${theme.text}" font-size="21" font-weight="600">${escapedRepository}</text>
    <text x="${margin.left}" y="69" fill="${theme.muted}" font-size="13">Cumulative GitHub stars · updated ${updatedFormatter.format(lastStar)}</text>
    <g transform="translate(${width - margin.right - 118}, 34)">
      <text x="0" y="17" fill="${theme.accent}" font-size="19">★</text>
      <text x="27" y="17" fill="${theme.text}" font-size="16" font-weight="600">${timestamps.length} stars</text>
    </g>
    ${yTicks.join("").trim()}
    ${xTicks.join("").trim()}
    <path d="${areaPath}" fill="url(#star-area)" />
    <path d="${linePath}" fill="none" stroke="${theme.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    <circle cx="${lastPoint.x.toFixed(1)}" cy="${lastPoint.y.toFixed(1)}" r="5" fill="${theme.background}" stroke="${theme.accent}" stroke-width="3" filter="url(#point-shadow)" />
    <text x="20" y="${margin.top + plotHeight / 2}" transform="rotate(-90 20 ${margin.top + plotHeight / 2})" text-anchor="middle" fill="${theme.muted}" font-size="13">GitHub stars</text>
  </g>
</svg>
`;
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
  for (const themeName of Object.keys(themes)) {
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
