import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Page } from "@playwright/test";
import { CoverageReport, type CoverageReportOptions } from "monocart-coverage-reports";

// Dashboard line coverage, on when UI_E2E_COVERAGE=1 (CI sets it). The page fixture records
// V8 JS coverage per test and adds it to a cache that every worker shares. Global teardown
// turns the cache into coverage/lcov.info for this shard. The report job merges the shards.
export const coverageEnabled = process.env.UI_E2E_COVERAGE === "1";

const packageRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageRoot, "../..");
const distDir = resolve(repoRoot, "apps/ui/dist");
export const coverageDir = resolve(packageRoot, "coverage");

const options: CoverageReportOptions = {
  name: "Dashboard (Playwright)",
  outputDir: coverageDir,
  baseDir: repoRoot,
  reports: [["lcovonly", { file: "lcov.info" }]],
  logging: "error",
  // Workers share the cache; only global setup clears it.
  cleanCache: false,
  // The bundle's own chunks. Vendor chunks (manualChunks in apps/ui/vite.config.ts) map to
  // node_modules only.
  entryFilter: (entry) => {
    const { pathname } = new URL(entry.url);
    return (
      pathname.startsWith("/assets/") && pathname.endsWith(".js") && !pathname.includes("vendor-")
    );
  },
  // Sourcemap paths come back relative to the bundle; keep dashboard sources only.
  sourceFilter: (sourcePath) => !sourcePath.includes("node_modules") && /\.tsx?$/.test(sourcePath),
  sourcePath: (filePath) => {
    const match = /(?:^|\/)src\//.exec(filePath);
    return match ? `apps/ui/${filePath.slice(match.index + match[0].length - 4)}` : filePath;
  },
  // Read maps from the build on disk instead of over HTTP.
  sourceMapResolver: async (url, defaultResolver) => {
    const { pathname } = new URL(url);
    const path = resolve(distDir, pathname.replace(/^\/+/, ""));
    if (!path.startsWith(`${distDir}${sep}`)) return defaultResolver(url);
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return defaultResolver(url);
    }
  },
};

export function coverageReport(): CoverageReport {
  return new CoverageReport(options);
}

export async function startCoverage(page: Page): Promise<void> {
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

// Coverage never fails a test: a closed page or a cache write error only loses that test's data.
export async function stopCoverage(page: Page): Promise<void> {
  try {
    const entries = await page.coverage.stopJSCoverage();
    await coverageReport().add(entries);
  } catch (error) {
    console.warn(`[ui-e2e] coverage not recorded: ${String(error)}`);
  }
}
