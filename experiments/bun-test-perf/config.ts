const config = {
  name: "bun-test-perf",

  prompt: `You are optimizing the bun test runner performance for a large TypeScript project.

## Goal
Minimize the total wall-clock time of \`bun test\` while keeping the exact same number of tests (2181 total).

## Current State
- 2181 tests across 121 files, currently taking ~44 seconds
- No bunfig.toml exists yet — bun uses all defaults
- Tests use isolated SQLite DBs (test-*.sqlite files created/cleaned per suite)
- Many test files do DB init/teardown in beforeAll/afterAll

## Target Files
- bunfig.toml — bun's configuration file (test runner settings)

## What You CAN Do
- Create or modify bunfig.toml to tune the [test] section
- Adjust test runner concurrency, timeout, preloading, coverage settings
- Configure smol mode, memory settings, module resolution
- Set test-specific environment variables via bunfig.toml

## What You CANNOT Do
- Modify any test files (*.test.ts)
- Modify source code files
- Delete or skip tests
- Install new packages
- Modify package.json

## Bun Test Config Reference
bunfig.toml [test] section supports:
- preload: array of scripts to run before tests
- smol: boolean — use less memory (may affect speed)
- coverage: boolean — disable coverage if enabled
- coverageReporter: array
- coverageDir: string
- root: string
- timeout: number (ms per test)
- bail: number — stop after N failures
- rerunEach: number

## Constraints
- Make ONE focused change per iteration
- The total test count MUST remain exactly 2181 after your change
- Focus on settings that affect parallelism, I/O, and startup overhead`,

  eval: {
    type: "command" as const,
    command: `bash -c '
      # Clean cached test DBs to ensure no stale state
      rm -f test-*.sqlite test-*.sqlite-wal test-*.sqlite-shm 2>/dev/null

      # Run bun test and capture output
      OUTPUT=$(bun test 2>&1)

      # Extract total test count (line like "Ran 2181 tests across 121 files.")
      TOTAL=$(echo "$OUTPUT" | sed -n "s/.*Ran \\([0-9]*\\) tests.*/\\1/p" | tail -1)

      # Extract time (line like "Ran 2181 tests across 121 files. [43.98s]")
      TIME=$(echo "$OUTPUT" | sed -n "s/.*\\[\\([0-9.]*\\)s\\].*/\\1/p" | tail -1)

      if [ -z "$TOTAL" ] || [ -z "$TIME" ]; then
        echo "Score: 9999"
        echo "ERROR: Could not parse test output"
        echo "$OUTPUT" | tail -20
        exit 0
      fi

      if [ "$TOTAL" -ne 2181 ]; then
        echo "Score: 9999"
        echo "ERROR: Expected 2181 tests but got $TOTAL"
        exit 0
      fi

      echo "Score: $TIME"
      echo "Tests: $TOTAL | Time: ${TIME}s"
    '`,
    scorePattern: /Score:\s+(?<score>[\d.]+)/,
  },

  direction: "minimize" as const,
  timeoutMs: 5 * 60 * 1000,
  allowedPaths: ["bunfig.toml"],
};

export default config;
