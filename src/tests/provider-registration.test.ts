import { describe, expect, test } from "bun:test";
import { buildPricingSeedRows } from "../be/seed-pricing";
import { CREDENTIAL_PROVIDER_CHECKERS } from "../commands/provider-credentials";
import { ProviderNameSchema } from "../types";

const entrypoint = await Bun.file(new URL("../../docker-entrypoint.sh", import.meta.url)).text();

const bootstrapStart = 'if [ "$HARNESS_PROVIDER" = "pi" ]; then';
const bootstrapEnd = "# ---- Verify provider binary is reachable ----";
const bootstrapBlock = entrypoint.slice(
  entrypoint.indexOf(bootstrapStart),
  entrypoint.indexOf(bootstrapEnd),
);

const modelsDevFixture = {
  anthropic: { models: { "claude-test": { cost: { input: 1, output: 2 } } } },
  openai: { models: { "gpt-test": { cost: { input: 1, output: 2 } } } },
  openrouter: { models: { "test/model": { cost: { input: 1, output: 2 } } } },
};

const ENTRYPOINT_EXEMPTIONS = new Set(["claude", "acp"]);
const ENTRYPOINT_OUTPUT: Record<string, string> = {
  pi: "Warning: pi provider has no credentials yet",
  opencode: "Warning: opencode provider has no credentials yet",
  "claude-managed": "Warning: claude-managed provider missing:",
  devin: "Warning: devin provider missing DEVIN_API_KEY / DEVIN_ORG_ID",
  codex: "Warning: codex provider has no auth.json yet",
};

async function runCredentialBootstrap(provider: string): Promise<{
  exitCode: number;
  stdout: string;
}> {
  const proc = Bun.spawn(["bash", "-c", bootstrapBlock], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: "/tmp/provider-registration-test",
      HARNESS_PROVIDER: provider,
      API_KEY: "",
      MCP_BASE_URL: "",
      MCP_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { exitCode, stdout: stdout.trim() };
}

describe("provider registration synchronization", () => {
  test("credential dispatcher has a concrete handler for every provider", () => {
    expect(Object.keys(CREDENTIAL_PROVIDER_CHECKERS).sort()).toEqual(
      [...ProviderNameSchema.options].sort(),
    );
  });

  test("pricing seeder emits rows for every provider except ACP", () => {
    const registered = new Set(buildPricingSeedRows(modelsDevFixture).map((row) => row.provider));
    const expected = ProviderNameSchema.options.filter((provider) => provider !== "acp");
    expect([...registered].filter((provider) => expected.includes(provider)).sort()).toEqual(
      [...expected].sort(),
    );
  });

  test.skipIf(process.platform === "win32")(
    "entrypoint executes a credential bootstrap for every non-exempt provider",
    async () => {
      for (const provider of ProviderNameSchema.options) {
        if (ENTRYPOINT_EXEMPTIONS.has(provider)) continue;
        const result = await runCredentialBootstrap(provider);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(ENTRYPOINT_OUTPUT[provider]);
      }
    },
  );
});
