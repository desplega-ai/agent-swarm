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
- Runtime: Bun 1.3.11, macOS arm64

## Target Files
- bunfig.toml — bun's configuration file (test runner settings)

## IMPORTANT: Do NOT waste time exploring
- Do NOT read test files — you cannot modify them
- Do NOT read source files — you cannot modify them
- ONLY create/modify bunfig.toml — go straight to writing it
- Look up bun test runner docs if needed, but don't explore the codebase

## What You CAN Do
- Create or modify bunfig.toml to tune the [test] section and other top-level settings
- Adjust test runner concurrency, timeout, preloading, coverage settings
- Configure smol mode, memory settings, module resolution
- Set test-specific environment variables via bunfig.toml
- Add top-level bun settings that affect startup/transpilation speed

## What You CANNOT Do
- Modify any test files (*.test.ts) or source files
- Delete or skip tests
- Install new packages or modify package.json
- Create preload scripts or any other files (only bunfig.toml)

## Bun Test Config Reference (bunfig.toml)
\`\`\`toml
[test]
coverage = false          # disable coverage collection
smol = true               # use less memory (trade memory for speed)
timeout = 30000           # per-test timeout in ms
preload = ["./setup.ts"]  # scripts to run before tests
root = "./src"            # test root directory
bail = 0                  # stop after N failures (0 = don't bail)
rerunEach = 1             # times to rerun each test

# Top-level settings that may help:
[install]
# lockfile settings

[run]
# runtime settings
\`\`\`

## Ideas to Explore (one per iteration)
- coverage = false (avoid coverage overhead)
- smol = true (reduced memory mode)
- Adjusting timeout to avoid waiting on slow tests
- root = "./src" (narrow test discovery scope)
- Top-level transpiler/resolver settings

## Constraints
- Make ONE focused change per iteration
- The total test count MUST remain exactly 2181 after your change
- Go straight to writing bunfig.toml — do not explore the codebase`,

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
      echo "Tests: $TOTAL | Time: $TIME seconds"
    '`,
    scorePattern: /Score:\s+(?<score>[\d.]+)/,
  },

  direction: "minimize" as const,
  timeoutMs: 10 * 60 * 1000,
  allowedPaths: ["bunfig.toml"],
};

export default config;
