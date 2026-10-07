import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildPricingSeedRows } from "../be/seed-pricing";
import {
  CREDENTIAL_PROVIDER_CHECKERS,
  validateProviderCredentials,
} from "../commands/provider-credentials";
import { createProviderAdapter } from "../providers";
import { PricingProviderSchema, type ProviderName, ProviderNameSchema } from "../types";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

/**
 * Every `ProviderNameSchema` member must reach every mandatory touch point, or
 * be exempted there with a one-line reason (#1559). A failure names the
 * provider and the file to edit.
 *
 * Some lists are subsets or supersets by design (PricingProviderSchema also
 * accepts `gemini`; the local-harness lists skip cloud providers), so each
 * touch point only asserts that every provider is present or consciously
 * exempted. An exemption for a provider that is actually present fails as
 * stale, so the map cannot rot.
 *
 * Touch points that are already compile-bound to one of these lists are not
 * repeated here: HARNESS_LABEL and ICON_BY_HARNESS (`Record<ProviderName, …>`
 * over the UI's PROVIDER_NAMES), ROUTING_PREFIXES_BY_PROVIDER
 * (`Record<PricingProvider, …>`), the session-costs `provider` field (reuses
 * PricingProviderSchema), DEFAULT_MODEL_TIER_MAP and PROVIDER_STEER_CAPABILITIES
 * (`Record<ProviderName, …>`; the factory switch is covered by
 * provider-steering-capabilities.test.ts).
 */

const repoRoot = join(import.meta.dir, "..", "..");

async function readRepoFile(relPath: string): Promise<string> {
  return Bun.file(join(repoRoot, relPath)).text();
}

/** The quoted members of the first array/enum literal matched by `pattern`. */
async function literalMembers(relPath: string, pattern: RegExp): Promise<string[]> {
  const match = (await readRepoFile(relPath)).match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not find ${pattern} in ${relPath}. Did the declaration move?`);
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** The provider names listed after `Supported:` in an unknown-provider error. */
function supportedList(message: string): string[] {
  const list = message.split("Supported:")[1];
  if (list === undefined) throw new Error(`No "Supported:" list in: ${message}`);
  return list
    .replace(/\.\s*$/, "")
    .split(",")
    .map((name) => name.trim());
}

const modelsDevFixture = {
  anthropic: { models: { "claude-test": { cost: { input: 1, output: 2 } } } },
  openai: { models: { "gpt-test": { cost: { input: 1, output: 2 } } } },
  openrouter: { models: { "test/model": { cost: { input: 1, output: 2 } } } },
  xai: { models: { "grok-test": { cost: { input: 1, output: 2 } } } },
};

interface TouchPoint {
  /** The file a new provider must be added to. */
  file: string;
  /** What inside that file. */
  what: string;
  members: () => Promise<readonly string[]>;
  /** Providers deliberately absent here, each with a one-line reason. */
  exempt: Partial<Record<ProviderName, string>>;
}

const TOUCH_POINTS: TouchPoint[] = [
  {
    file: "src/commands/provider-credentials.ts",
    what: "CREDENTIAL_PROVIDER_CHECKERS (and the SupportedProvider union it is keyed by)",
    members: async () => Object.keys(CREDENTIAL_PROVIDER_CHECKERS),
    exempt: {},
  },
  {
    file: "src/commands/provider-credentials.ts",
    what: "the validateProviderCredentials switch (dashboard Test connection)",
    members: async () => {
      const source = await readRepoFile("src/commands/provider-credentials.ts");
      const start = source.indexOf("export async function validateProviderCredentials(");
      const end = source.indexOf("\n}\n", start);
      if (start === -1 || end === -1) {
        throw new Error(
          "Could not find validateProviderCredentials in src/commands/provider-credentials.ts.",
        );
      }
      return [...source.slice(start, end).matchAll(/case "([^"]+)":/g)].map((m) => m[1] as string);
    },
    exempt: {},
  },
  {
    file: "src/commands/provider-credentials.ts",
    what: "the validateProviderCredentials unknown-provider error message",
    members: async () => {
      const result = await validateProviderCredentials("__unregistered_provider__");
      return supportedList(result.ok ? "" : result.error);
    },
    exempt: {},
  },
  {
    file: "src/providers/index.ts",
    what: "the createProviderAdapter unknown-provider error message",
    members: async () => {
      try {
        await createProviderAdapter("__unregistered_provider__");
      } catch (error) {
        return supportedList(String(error));
      }
      throw new Error("createProviderAdapter accepted an unregistered provider.");
    },
    exempt: {},
  },
  {
    file: "src/types.ts",
    what: "PricingProviderSchema (#1636; the session-costs provider field reuses it)",
    members: async () => PricingProviderSchema.options,
    exempt: {},
  },
  {
    file: "src/be/seed-pricing.ts",
    what: "the provider rows buildPricingSeedRows emits",
    members: async () => [
      ...new Set(buildPricingSeedRows(modelsDevFixture).map((row) => row.provider)),
    ],
    exempt: {
      acp: "A generic ACP target owns its own billing and the adapter reports totalCostUsd: 0.",
    },
  },
  {
    file: "apps/ui/src/api/types.ts",
    what: "PROVIDER_NAMES (#1637; HARNESS_LABEL and ICON_BY_HARNESS are typed against it)",
    members: () =>
      literalMembers("apps/ui/src/api/types.ts", /export const PROVIDER_NAMES = \[([^\]]*)\]/),
    exempt: {},
  },
  {
    file: "src/http/agents.ts",
    what: "LocalHarnessProviderSchema (PATCH /api/agents/{id}/runtime)",
    members: () =>
      literalMembers(
        "src/http/agents.ts",
        /const LocalHarnessProviderSchema = z\.enum\(\[([^\]]*)\]/,
      ),
    exempt: {
      "claude-managed":
        "Cloud harness: runs in Anthropic's sandbox, no local runtime to configure.",
      devin: "Cloud harness: runs on Devin's API, no local runtime to configure.",
    },
  },
  {
    file: "apps/ui/src/lib/agent-runtime-models.ts",
    what: "LOCAL_HARNESSES (dashboard runtime harness picker)",
    members: () =>
      literalMembers(
        "apps/ui/src/lib/agent-runtime-models.ts",
        /export const LOCAL_HARNESSES[^=]*=\s*\[([^\]]*)\]/,
      ),
    exempt: {
      "claude-managed":
        "Cloud harness: runs in Anthropic's sandbox, no local runtime to configure.",
      devin: "Cloud harness: runs on Devin's API, no local runtime to configure.",
    },
  },
];

describe("provider registration synchronization", () => {
  for (const touchPoint of TOUCH_POINTS) {
    describe(`${touchPoint.file}: ${touchPoint.what}`, () => {
      test("the extractor finds the list and every exemption is still needed", async () => {
        const members = await touchPoint.members();
        expect(members.length).toBeGreaterThan(0);
        const stale = Object.keys(touchPoint.exempt).filter((provider) =>
          members.includes(provider),
        );
        if (stale.length > 0) {
          throw new Error(
            `Stale exemption in ${touchPoint.file} (${touchPoint.what}): ${stale.join(", ")} is now present. Remove it from the exempt map in src/tests/provider-registration.test.ts.`,
          );
        }
      });

      for (const provider of ProviderNameSchema.options) {
        if (touchPoint.exempt[provider]) continue;
        test(`registers ${provider}`, async () => {
          const members = await touchPoint.members();
          if (!members.includes(provider)) {
            throw new Error(
              `Provider "${provider}" is missing from ${touchPoint.what} in ${touchPoint.file}. Add it there, or exempt it for this touch point in src/tests/provider-registration.test.ts with a one-line reason.`,
            );
          }
        });
      }
    });
  }
});

// ─── docker-entrypoint.sh ────────────────────────────────────────────────────
// Bash chains a TS type cannot reach, so these run the real blocks in a bash
// subprocess and check which branch each provider lands in.

const entrypoint = await readRepoFile("docker-entrypoint.sh");

const bootstrapStart = 'if [ "$HARNESS_PROVIDER" = "pi" ]; then';
const bootstrapEnd = "# ---- Verify provider binary is reachable ----";
const bootstrapBlock = entrypoint.slice(
  entrypoint.indexOf(bootstrapStart),
  entrypoint.indexOf(bootstrapEnd),
);
const codexHomeAssignment = 'WORKER_CODEX_HOME="/home/worker/.codex"';
const isolatedBootstrapBlock = bootstrapBlock.replace(
  codexHomeAssignment,
  'WORKER_CODEX_HOME="$TEST_WORKER_CODEX_HOME"',
);
if (isolatedBootstrapBlock === bootstrapBlock) {
  throw new Error(`Could not isolate entrypoint assignment: ${codexHomeAssignment}`);
}

/**
 * The line each provider's credential-bootstrap branch prints with no
 * credentials set, or why it has no branch. Typed over every provider, so a
 * new one does not compile until it is listed here.
 */
const BOOTSTRAP: Record<ProviderName, { expect: string } | { exempt: string }> = {
  claude: { expect: "Warning: claude provider has no credentials yet" },
  dsh: { expect: "Warning: dsh provider has no credentials yet" },
  amp: { expect: "Warning: amp provider has no credentials yet" },
  cursor: { expect: "Warning: cursor provider has no credentials yet" },
  grok: { expect: "Warning: grok provider has no credentials yet" },
  pi: { expect: "Warning: pi provider has no credentials yet" },
  opencode: { expect: "Warning: opencode provider has no credentials yet" },
  "claude-managed": { expect: "Warning: claude-managed provider missing:" },
  devin: { expect: "Warning: devin provider missing DEVIN_API_KEY / DEVIN_ORG_ID" },
  codex: { expect: "Warning: codex provider has no auth.json yet" },
  acp: {
    exempt:
      "KNOWN GAP (#1559): no acp branch, so it falls into the claude else branch and prints the claude warning.",
  },
};

async function runCredentialBootstrap(provider: string): Promise<{
  exitCode: number;
  stdout: string;
}> {
  const testRoot = await mkdtemp(join(tmpdir(), "provider-registration-"));
  try {
    const proc = Bun.spawn(["bash", "-c", isolatedBootstrapBlock], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: join(testRoot, "home"),
        TEST_WORKER_CODEX_HOME: join(testRoot, "codex"),
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
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

function extractMarkedBlock(name: string): string {
  const begin = entrypoint.indexOf(`# BEGIN ${name}`);
  const end = entrypoint.indexOf(`# END ${name}`, begin);
  if (begin === -1 || end === -1) {
    throw new Error(`Could not find the # BEGIN/END ${name} markers in docker-entrypoint.sh.`);
  }
  return entrypoint.slice(begin, end);
}

/** Resolvable no-op stubs for every binary the verify chain may look up. */
function makeBinaryStubDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "provider-registration-bin-"));
  for (const name of ["claude", "codex", "opencode", "dsh", "amp", "grok"]) {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

describe.skipIf(process.platform === "win32")("docker-entrypoint.sh provider chains", () => {
  for (const provider of ProviderNameSchema.options) {
    const entry = BOOTSTRAP[provider] as (typeof BOOTSTRAP)[ProviderName] | undefined;
    if (entry && !("expect" in entry)) {
      test(`credential bootstrap exemption for ${provider} is still needed`, async () => {
        const result = await runCredentialBootstrap(provider);
        if (result.stdout.includes(`Warning: ${provider} provider`)) {
          throw new Error(
            `Stale exemption: docker-entrypoint.sh now has a ${provider} credential-bootstrap branch. Replace its BOOTSTRAP exemption in src/tests/provider-registration.test.ts with the warning it prints.`,
          );
        }
      });
      continue;
    }
    test(`credential bootstrap has a ${provider} branch`, async () => {
      if (!entry) {
        throw new Error(
          `Provider "${provider}" is missing from BOOTSTRAP in src/tests/provider-registration.test.ts. Add its docker-entrypoint.sh credential warning, or an exemption with a one-line reason.`,
        );
      }
      const result = await runCredentialBootstrap(provider);
      expect(result.exitCode).toBe(0);
      if (!result.stdout.includes(entry.expect)) {
        throw new Error(
          `Provider "${provider}" has no credential-bootstrap branch in docker-entrypoint.sh (expected "${entry.expect}", got "${result.stdout}"). Add an elif, or exempt it in BOOTSTRAP with a one-line reason.`,
        );
      }
    });
  }

  // #1463 class: a provider with no branch of its own falls through to the
  // catch-all and gets the claude CLI checked instead of its own binary.
  const verifyChain = extractMarkedBlock("verify_provider_binary");
  for (const provider of ProviderNameSchema.options) {
    test(
      `verify_provider_binary does not route ${provider} through another provider's check`,
      async () => {
        const stubDir = makeBinaryStubDir();
        const result = await runChild(["bash", "-c", verifyChain], {
          env: {
            PATH: [stubDir, "/usr/bin", "/bin"].join(delimiter),
            HARNESS_PROVIDER: provider,
            ACP_TARGET: "opencode",
          },
        });
        await rm(stubDir, { recursive: true, force: true });
        expect(result.exitCode).toBe(0);
        const checkedClaude = result.stdout.includes("Claude CLI:");
        if (checkedClaude !== (provider === "claude")) {
          throw new Error(
            `Provider "${provider}" ${checkedClaude ? "falls through to the claude CLI check" : "skips the claude CLI check"} in docker-entrypoint.sh verify_provider_binary. Give it its own elif, or add it to the final \`!= "pi"\` guard if it has no binary.`,
          );
        }
      },
      CHILD_PROCESS_TEST_BUDGET_MS,
    );
  }
});
