#!/usr/bin/env bun
/**
 * Asserts that every Bun version pin in the repo equals `packageManager` in
 * package.json. `packageManager` is the single source of truth: setup-bun reads
 * it in CI (`bun-version-file: package.json`), but Dockerfiles cannot, so their
 * literal tags are checked here. A missing pin is a failure too.
 *
 * Usage: bun scripts/check-bun-version.ts
 * Exit 1 with a per-pin report when any pin drifts.
 */

const PACKAGE_JSON = "package.json";

type Pin = {
  file: string;
  /** Line-anchored regex with one capture group: the version. Every match must equal packageManager. */
  pattern: RegExp;
  /** Human label for the report. */
  what: string;
};

const FROM_OVEN_BUN = /^FROM oven\/bun:([^\s]+)/gm;

const PINS: Pin[] = [
  { file: "Dockerfile", pattern: FROM_OVEN_BUN, what: "FROM oven/bun tag" },
  { file: "Dockerfile.worker", pattern: FROM_OVEN_BUN, what: "FROM oven/bun tag" },
  {
    file: "Dockerfile.worker",
    pattern: /^RUN [^\n]*bun\.sh\/install \| [^\n]*bash -s "bun-v([^"]+)"/gm,
    what: "runtime bun.sh/install pin",
  },
  { file: "apps/evals/Dockerfile", pattern: FROM_OVEN_BUN, what: "FROM oven/bun tag" },
];

async function readPackageManagerVersion(): Promise<string> {
  const packageJson = (await Bun.file(PACKAGE_JSON).json()) as { packageManager?: unknown };
  const raw = packageJson.packageManager;
  const match = typeof raw === "string" ? raw.match(/^bun@(\d+\.\d+\.\d+)$/) : null;
  if (!match) {
    throw new Error(
      `${PACKAGE_JSON} packageManager must look like "bun@X.Y.Z", got ${String(raw)}`,
    );
  }
  return match[1];
}

async function main(): Promise<void> {
  const expected = await readPackageManagerVersion();
  const problems: string[] = [];
  let checked = 0;

  for (const pin of PINS) {
    const file = Bun.file(pin.file);
    if (!(await file.exists())) {
      problems.push(`${pin.file}: file not found`);
      continue;
    }
    const text = await file.text();
    const matches = [...text.matchAll(pin.pattern)];
    if (matches.length === 0) {
      problems.push(`${pin.file}: no ${pin.what} found`);
      continue;
    }
    for (const match of matches) {
      checked += 1;
      const found = match[1];
      if (found !== expected) {
        problems.push(`${pin.file}: ${pin.what} is ${found}, expected ${expected}`);
      }
    }
  }

  if (problems.length > 0) {
    console.error(
      [
        `Bun version pins are out of sync with ${PACKAGE_JSON} packageManager (bun@${expected}).`,
        ...problems.map((problem) => `  - ${problem}`),
        "Update the pins above (or packageManager) so every Bun version matches, then confirm `bun install --frozen-lockfile` still passes on the new runtime.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`${checked} Bun version pin(s) match ${PACKAGE_JSON} packageManager bun@${expected}`);
}

await main();
