/**
 * The CLI entry under `bun test`, so Bun writes lcov for it, as coverage-sut.ts does for the
 * API. `bun run e2e --coverage` starts a CLI scenario's child as
 * `bun --config=<toml> test ./scripts/e2e/coverage-cli.ts` from the repo root instead of
 * `bun run src/cli.tsx <args>` from the scenario's directory. Not a `*.test.ts` file, so the
 * root unit run never picks it up.
 *
 * The wrapper sets argv and the working directory from E2E_CLI_ARGV and E2E_CLI_CWD, then
 * imports the CLI. The command ends one of three ways: it calls `process.exit` (trapped here,
 * so Bun still writes lcov), its top-level await settles, or its Ink app exits. The real
 * exit code goes to E2E_CLI_EXIT_FILE; the test itself always passes.
 */
import { test } from "bun:test";

test(
  "CLI process under coverage",
  async () => {
    const argv = JSON.parse(process.env.E2E_CLI_ARGV ?? "[]") as string[];
    const exitFile = process.env.E2E_CLI_EXIT_FILE ?? "";
    const exited = new Promise<number>((resolve) => {
      process.exit = ((code?: number | string | null) => {
        resolve(Number(code ?? process.exitCode ?? 0));
      }) as typeof process.exit;
    });
    // Ink renders the UI commands; wait for their app to unmount, not for the import. A probe
    // around the tree, not waitUntilExit: an app that exits during its first render (an
    // unknown command) unmounts before anyone can wait, and that promise never settles.
    const ink = await import("ink");
    const { createElement, useEffect } = await import("react");
    // Taken before the mock: mock.module rewrites the live namespace, ink.render included.
    const realRender = ink.render;
    let inkExit: Promise<void> | undefined;
    const { mock } = await import("bun:test");
    mock.module("ink", () => ({
      ...ink,
      render: (
        node: Parameters<typeof realRender>[0],
        options?: Parameters<typeof realRender>[1],
      ) => {
        let unmounted = () => {};
        inkExit = new Promise<void>((resolve) => {
          unmounted = resolve;
        });
        const Probe = ({ children }: { children: typeof node }) => {
          useEffect(() => unmounted, []);
          return children;
        };
        return realRender(createElement(Probe, null, node), options);
      },
    }));
    process.argv = [process.argv[0] ?? "bun", `${import.meta.dir}/../../src/cli.tsx`, ...argv];
    // Back to the repo root before the run ends: Bun writes lcov paths relative to the cwd.
    const root = process.cwd();
    if (process.env.E2E_CLI_CWD) process.chdir(process.env.E2E_CLI_CWD);
    const settled = (async () => {
      await import(`${import.meta.dir}/../../src/cli.tsx`);
      if (inkExit) await inkExit;
      return Number(process.exitCode ?? 0);
    })().catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      return 1;
    });
    const code = await Promise.race([exited, settled]);
    process.chdir(root);
    if (exitFile) await Bun.write(exitFile, String(code));
  },
  // The runner bounds each CLI child with its own timeout.
  2 ** 31 - 1,
);
