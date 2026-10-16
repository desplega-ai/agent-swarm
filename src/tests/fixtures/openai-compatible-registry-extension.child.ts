/**
 * Proof that adding an OpenAI-compatible provider takes one registry entry.
 *
 * A fake `testgw` entry is added to the registry table
 * (`packages/model-catalog/src/openai-compatible-providers.ts`) through
 * `mock.module`, without editing any production file, and must reach
 * credential routing, the opencode config, the pi models.json writer, the
 * dashboard integration cards and the model picker groups.
 *
 * The mock is installed before any consumer below is imported (dynamic
 * imports). Consumers cache derivations of the table at import (the
 * integration cards, the picker constants), and `mock.module` cannot undo
 * those, so this file only runs in its own `bun test` child process,
 * spawned by `src/tests/openai-compatible-registry-extension.test.ts`. Its
 * name keeps it out of the root test glob.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REGISTRY_MODULE = "../../../packages/model-catalog/src/openai-compatible-providers.ts";

const TESTGW = {
  id: "testgw",
  displayName: "TestGW",
  description: "A fake gateway for the registry extension test.",
  baseUrl: "https://testgw.invalid/v1",
  docsUrl: "https://testgw.invalid/docs",
  envVar: "TESTGW_API_KEY",
  aliasEnvVars: [],
  catalog: "registry",
  npm: "@ai-sdk/openai-compatible",
  models: [
    {
      id: "m1",
      name: "Test Model 1",
      contextWindow: 131072,
      maxOutputTokens: 8192,
      input: ["text"],
      reasoning: true,
      compat: { supportsDeveloperRole: true },
      reasoningEfforts: ["low", "high"],
    },
  ],
} as const;

const real = (await import(REGISTRY_MODULE)) as {
  OPENAI_COMPATIBLE_PROVIDERS: Record<string, unknown>;
};
const original = real.OPENAI_COMPATIBLE_PROVIDERS;
mock.module(REGISTRY_MODULE, () => ({
  OPENAI_COMPATIBLE_PROVIDERS: { ...original, testgw: TESTGW },
}));

// The test preload already loaded `src/utils/credentials.ts`, so only its
// call-time paths (routing, pooling) see the mock; `CREDENTIAL_POOL_VARS` is
// fixed at import and covered by the registry spread in its declaration.
const { getModelAwareCredentialVars, resolveCredentialPools } = await import(
  "../../utils/credentials"
);
const { applyProviderKeySplice } = await import("../../providers/opencode-adapter");
type OpencodeConfig = import("../../providers/opencode-adapter").OpencodeConfig;
const { writeSessionModelsJson } = await import("../../providers/pi-mono-adapter");
const { INTEGRATIONS } = await import("../../../apps/ui/src/lib/integrations-catalog");
const { modelGroupsForHarness } = await import("../../../apps/ui/src/lib/agent-runtime-models");

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

describe("a new registry entry (testgw) reaches every derived surface", () => {
  test("credential routing picks its key on pi and opencode", () => {
    expect(getModelAwareCredentialVars("pi", "testgw/x")).toEqual(["TESTGW_API_KEY"]);
    expect(getModelAwareCredentialVars("opencode", "testgw/x")).toEqual(["TESTGW_API_KEY"]);
  });

  test("its key pools alone for a testgw/* model", async () => {
    const env: Record<string, string | undefined> = {
      TESTGW_API_KEY: "example-gw-a,example-gw-b",
      OPENROUTER_API_KEY: "example-or-a,example-or-b",
    };
    const selections = await resolveCredentialPools(env, { provider: "pi", model: "testgw/m1" });
    expect(["example-gw-a", "example-gw-b"]).toContain(env.TESTGW_API_KEY ?? "");
    expect(selections.map((s) => [s.keyType, s.total])).toEqual([["TESTGW_API_KEY", 2]]);
    expect(env.OPENROUTER_API_KEY).toBe("example-or-a,example-or-b");
  });

  test("opencode gets a custom block with the picked key at the base URL", () => {
    const config: OpencodeConfig = {};
    const picked = applyProviderKeySplice(config, "testgw/m1", { TESTGW_API_KEY: "k1,k2" });
    expect(picked).toEqual({ key: "k1", name: "TESTGW_API_KEY" });
    const block = config.provider?.testgw;
    expect(block?.npm).toBe("@ai-sdk/openai-compatible");
    expect(block?.env).toEqual([]);
    expect(block?.options).toEqual({ baseURL: "https://testgw.invalid/v1", apiKey: "k1" });
    expect(block?.models?.m1).toMatchObject({ name: "Test Model 1", tool_call: true });

    const overridden: OpencodeConfig = {};
    applyProviderKeySplice(overridden, "testgw/m1", {
      TESTGW_API_KEY: "k1",
      TESTGW_BASE_URL: "http://127.0.0.1:9/v1",
    });
    expect(overridden.provider?.testgw?.options?.baseURL).toBe("http://127.0.0.1:9/v1");
  });

  test("the pi models.json writer adds its provider block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "testgw-pi-"));
    tmpDirs.push(dir);
    const models = await writeSessionModelsJson(dir, { TESTGW_API_KEY: "k1" }, "testgw/m1");
    const written = JSON.parse(await readFile(models.modelsPath as string, "utf-8"));
    await models.dispose();
    expect(written.providers.testgw).toMatchObject({
      baseUrl: "https://testgw.invalid/v1",
      api: "openai-completions",
      apiKey: "$TESTGW_API_KEY",
    });
    expect(written.providers.testgw.models.map((m: { id: string }) => m.id)).toEqual(["m1"]);
  });

  test("the dashboard lists an integration card with its key and base URL", () => {
    const card = INTEGRATIONS.find((def) => def.id === "testgw");
    expect(card?.name).toBe("TestGW");
    expect(card?.providerIconKey as string | undefined).toBe("testgw");
    expect(card?.fields.map((f) => [f.key, f.isSecret])).toEqual([
      ["TESTGW_API_KEY", true],
      ["TESTGW_BASE_URL", false],
    ]);
  });

  test("the picker shows its models, locked without a key and enabled with one", () => {
    for (const harness of ["pi", "opencode"] as const) {
      const locked = modelGroupsForHarness(harness, [], {}).find((g) => g.provider === "TestGW");
      expect(locked?.enabled).toBe(false);
      expect(locked?.requiredKey).toBe("TESTGW_API_KEY");
      expect(locked?.models.map((m) => m.id)).toEqual(["testgw/m1"]);
      expect(locked?.models[0]?.reasoningLevels).toEqual(["low", "high"]);

      const enabled = modelGroupsForHarness(harness, [], { TESTGW_API_KEY: true }).find(
        (g) => g.provider === "TestGW",
      );
      expect(enabled?.enabled).toBe(true);
    }
  });
});
