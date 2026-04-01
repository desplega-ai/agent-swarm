const config = {
  name: "bun-test-perf",

  prompt: `You are optimizing the wall-clock time of \`bun test\` in a TypeScript project.

## Goal
Make \`bun test\` run faster. That's it.

## Baseline
- 2181 tests across 121 files, ~44 seconds
- Bun 1.3.11, macOS arm64
- Tests use isolated SQLite DBs (test-*.sqlite, created per suite)

## Rules
1. \`bun test\` must still pass — total test count must be >= 2181
2. No deleting or skipping tests
3. Make ONE focused change per iteration

## Everything else is fair game
You can modify any file, create new files, add helpers, preload scripts, change config, restructure — whatever you think will help. Think from first principles about what makes test suites slow and what levers you have.

Some areas to consider (not exhaustive):
- Bun test runner config (bunfig.toml)
- Test setup/teardown patterns (DB init, migrations)
- Module resolution and transpilation overhead
- Parallelism and concurrency
- Preload scripts that cache expensive operations
- File I/O patterns (SQLite WAL mode, tmpfs, etc.)`,

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

      if [ "$TOTAL" -lt 2181 ]; then
        echo "Score: 9999"
        echo "ERROR: Expected >= 2181 tests but got $TOTAL"
        exit 0
      fi

      echo "Score: $TIME"
      echo "Tests: $TOTAL | Time: $TIME seconds"
    '`,
    scorePattern: /Score:\s+(?<score>[\d.]+)/,
  },

  direction: "minimize" as const,
  timeoutMs: 10 * 60 * 1000,
  // no allowedPaths restriction — proposer can modify anything
};

export default config;
