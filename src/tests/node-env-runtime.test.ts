import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

// `bun build --compile` inlines `process.env.NODE_ENV` dot reads as
// "development". Compile a tiny entry with the API Dockerfile's flags and
// check that the SSRF guard and `getNodeEnv` see the runtime value.
// scripts/check-node-env-access.sh keeps new dot reads out of src/.

const SRC = resolve(import.meta.dir, "..");

let dir: string;
let binary: string;

function runBinary(nodeEnv: string | undefined) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.NODE_ENV;
  delete env.ALLOW_PRIVATE_NETWORK_URLS;
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  return runChild([binary], { env }).then((r) => JSON.parse(expectChildOk(r, binary).stdout));
}

describe("NODE_ENV in compiled binaries", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "node-env-compile-"));
    const entry = join(dir, "entry.ts");
    binary = join(dir, "entry-bin");
    await Bun.write(
      entry,
      [
        `import { publicEndpointSsrfOptions } from ${JSON.stringify(join(SRC, "oauth/mcp-wrapper.ts"))};`,
        `import { getNodeEnv } from ${JSON.stringify(join(SRC, "utils/node-env.ts"))};`,
        "console.log(JSON.stringify({ nodeEnv: getNodeEnv() ?? null, ssrf: publicEndpointSsrfOptions() }));",
      ].join("\n"),
    );
    // Same flags as the API binary in Dockerfile.
    const build = await runChild([
      process.execPath,
      "build",
      entry,
      "--compile",
      "--compile-exec-argv=--expose-gc",
      "--outfile",
      binary,
    ]);
    expectChildOk(build, "bun build --compile");
  }, CHILD_PROCESS_TEST_BUDGET_MS);

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test(
    "NODE_ENV unset: the SSRF guard blocks private and insecure endpoints",
    async () => {
      expect(await runBinary(undefined)).toEqual({
        nodeEnv: null,
        ssrf: { allowPrivateHosts: false, allowInsecure: false },
      });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "NODE_ENV=production is seen at runtime",
    async () => {
      expect(await runBinary("production")).toEqual({
        nodeEnv: "production",
        ssrf: { allowPrivateHosts: false, allowInsecure: false },
      });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "NODE_ENV=development still opens the guard",
    async () => {
      expect(await runBinary("development")).toEqual({
        nodeEnv: "development",
        ssrf: { allowPrivateHosts: true, allowInsecure: true },
      });
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
