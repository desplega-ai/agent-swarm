/**
 * The API entry under `bun test`, so Bun writes lcov for it. `bun run e2e --coverage` starts
 * the SUT as `bun --config=<toml> test ./scripts/e2e/coverage-sut.ts` instead of
 * `bun run src/http.ts`. Not a `*.test.ts` file, so the root unit run never picks it up.
 *
 * Bun writes coverage only when the test run ends, and `process.exit` would skip that. The
 * API's SIGTERM handler ends with `process.exit(0)`, so the exit resolves the one test here
 * and the run ends normally. The path is computed: the runner stays black-box (it only
 * starts the entry as a process, as `bun run src/http.ts` does).
 */
import { test } from "bun:test";

test(
  "API process under coverage",
  async () => {
    const exited = new Promise<number>((resolve) => {
      process.exit = ((code?: number | string | null) => {
        resolve(Number(code ?? process.exitCode ?? 0));
      }) as typeof process.exit;
    });
    await import(`${import.meta.dir}/../../src/http.ts`);
    const code = await exited;
    if (code !== 0) throw new Error(`API exited with code ${code}`);
  },
  // The API runs as long as the scenarios need it; the runner stops it with SIGTERM.
  2 ** 31 - 1,
);
