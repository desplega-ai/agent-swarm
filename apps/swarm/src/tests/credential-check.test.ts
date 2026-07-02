import { describe, expect, mock, test } from "bun:test";
import {
  buildCredStatusReport,
  checkProviderCredentials,
  isCredCheckDisabled,
  REQUIRED_CRED_VARS_BY_PROVIDER,
} from "../commands/provider-credentials";
import { checkClaudeCredentials } from "../providers/claude-adapter";
import { checkClaudeManagedCredentials } from "../providers/claude-managed-adapter";
import { checkCodexCredentials } from "../providers/codex-adapter";
import { checkDevinCredentials } from "../providers/devin-adapter";
import { checkOpencodeCredentials } from "../providers/opencode-adapter";
import { checkPiMonoCredentials } from "../providers/pi-mono-adapter";
import { AgentCredStatusSchema } from "../types";

/** Build a stub `fs` whose `existsSync` returns true only for paths in the set. */
function fsWith(present: Set<string>): { existsSync(p: string): boolean } {
  return { existsSync: (p: string) => present.has(p) };
}

const noFiles = fsWith(new Set());

// ─── claude ──────────────────────────────────────────────────────────────────

describe("checkClaudeCredentials", () => {
  test("ready when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
    const status = checkClaudeCredentials({ CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(status.ready).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.satisfiedBy).toBe("env");
  });

  test("ready when only ANTHROPIC_API_KEY is set", () => {
    const status = checkClaudeCredentials({ ANTHROPIC_API_KEY: "sk-ant" });
    expect(status.ready).toBe(true);
  });

  test("not ready when both unset, lists both as missing with hint", () => {
    const status = checkClaudeCredentials({});
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    expect(status.hint).toBeTruthy();
  });
});

// ─── claude-managed ──────────────────────────────────────────────────────────

describe("checkClaudeManagedCredentials", () => {
  const full = {
    ANTHROPIC_API_KEY: "sk-ant",
    MANAGED_AGENT_ID: "ag_123",
    MANAGED_ENVIRONMENT_ID: "env_123",
    MCP_BASE_URL: "https://swarm.example",
  };

  test("ready when all four are set", () => {
    const status = checkClaudeManagedCredentials(full);
    expect(status.ready).toBe(true);
    expect(status.missing).toEqual([]);
  });

  test("not ready when any one is missing", () => {
    for (const drop of Object.keys(full) as Array<keyof typeof full>) {
      const env: Record<string, string | undefined> = { ...full };
      delete env[drop];
      const status = checkClaudeManagedCredentials(env);
      expect(status.ready).toBe(false);
      expect(status.missing).toContain(drop);
    }
  });

  test("not ready when env is empty, lists all four as missing", () => {
    const status = checkClaudeManagedCredentials({});
    expect(status.ready).toBe(false);
    expect(status.missing.sort()).toEqual(
      ["ANTHROPIC_API_KEY", "MANAGED_AGENT_ID", "MANAGED_ENVIRONMENT_ID", "MCP_BASE_URL"].sort(),
    );
    expect(status.hint).toContain("claude-managed-setup");
  });
});

// ─── devin ───────────────────────────────────────────────────────────────────

describe("checkDevinCredentials", () => {
  test("ready when both keys are set", () => {
    expect(checkDevinCredentials({ DEVIN_API_KEY: "k", DEVIN_ORG_ID: "o" }).ready).toBe(true);
  });

  test("not ready when org id is missing", () => {
    const status = checkDevinCredentials({ DEVIN_API_KEY: "k" });
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["DEVIN_ORG_ID"]);
  });

  test("not ready when both are missing", () => {
    const status = checkDevinCredentials({});
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["DEVIN_API_KEY", "DEVIN_ORG_ID"]);
  });
});

// ─── codex ───────────────────────────────────────────────────────────────────

describe("checkCodexCredentials", () => {
  const HOME = "/home/worker";
  const AUTH = `${HOME}/.codex/auth.json`;

  test("ready (file) when ~/.codex/auth.json exists", () => {
    const status = checkCodexCredentials({}, { homeDir: HOME, fs: fsWith(new Set([AUTH])) });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("file");
  });

  test("ready (side-effect-pending) when OPENAI_API_KEY is set but auth.json absent", () => {
    const status = checkCodexCredentials(
      { OPENAI_API_KEY: "sk-proj" },
      { homeDir: HOME, fs: noFiles },
    );
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("side-effect-pending");
  });

  test("ready (side-effect-pending) when CODEX_OAUTH is set", () => {
    const status = checkCodexCredentials({ CODEX_OAUTH: "{}" }, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("side-effect-pending");
  });

  test("not ready when nothing is present, missing list includes both env keys + the file", () => {
    const status = checkCodexCredentials({}, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("OPENAI_API_KEY");
    expect(status.missing).toContain("CODEX_OAUTH");
    expect(status.missing).toContain(AUTH);
  });
});

// ─── pi-mono ─────────────────────────────────────────────────────────────────

/**
 * Stub probes for Bedrock tests. These replace the real @aws-sdk/client-bedrock
 * `ListFoundationModels` + `ListInferenceProfiles` enumeration so unit tests
 * never hit AWS.
 */
const bedrockProbeSuccess = async () => {};
const bedrockProbeAuthFail = async () => {
  throw new Error("ExpiredTokenException: The security token included in the request is expired");
};
const bedrockProbeAccessFail = async () => {
  throw new Error("AccessDeniedException: not authorized to perform: bedrock:ListFoundationModels");
};
const bedrockProbeRegionFail = async () => {
  throw new Error(
    "ValidationException: Provided region us-west-99 is not supported by Amazon Bedrock",
  );
};

describe("checkPiMonoCredentials", () => {
  const HOME = "/home/worker";
  const AUTH = `${HOME}/.pi/agent/auth.json`;

  test("ready (file) when ~/.pi/agent/auth.json exists", async () => {
    const status = await checkPiMonoCredentials({}, { homeDir: HOME, fs: fsWith(new Set([AUTH])) });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("file");
  });

  test("permissive: ready when MODEL_OVERRIDE unset and any one supported key is present", async () => {
    expect(
      (await checkPiMonoCredentials({ ANTHROPIC_API_KEY: "x" }, { homeDir: HOME, fs: noFiles }))
        .ready,
    ).toBe(true);
    expect(
      (await checkPiMonoCredentials({ OPENROUTER_API_KEY: "x" }, { homeDir: HOME, fs: noFiles }))
        .ready,
    ).toBe(true);
    expect(
      (await checkPiMonoCredentials({ OPENAI_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })).ready,
    ).toBe(true);
  });

  test("permissive: not ready when MODEL_OVERRIDE unset and no keys are set", async () => {
    const status = await checkPiMonoCredentials({}, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("ANTHROPIC_API_KEY");
    expect(status.missing).toContain("OPENROUTER_API_KEY");
    expect(status.missing).toContain("OPENAI_API_KEY");
  });

  test("strict: MODEL_OVERRIDE=anthropic/... requires ANTHROPIC_API_KEY", async () => {
    const env = { MODEL_OVERRIDE: "anthropic/claude-sonnet-4" };
    expect((await checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles })).ready).toBe(false);
    expect(
      (
        await checkPiMonoCredentials(
          { ...env, ANTHROPIC_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);
    // OPENROUTER_API_KEY does NOT satisfy an anthropic-prefixed model
    expect(
      (
        await checkPiMonoCredentials(
          { ...env, OPENROUTER_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(false);
  });

  test("strict: MODEL_OVERRIDE=openrouter/... requires OPENROUTER_API_KEY", async () => {
    const env = { MODEL_OVERRIDE: "openrouter/google/gemini-2.5-flash-lite" };
    expect(
      (
        await checkPiMonoCredentials(
          { ...env, OPENROUTER_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);
    expect(
      (
        await checkPiMonoCredentials(
          { ...env, ANTHROPIC_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(false);
  });

  test("shortname `sonnet` accepts ANTHROPIC_API_KEY *or* OPENROUTER_API_KEY", async () => {
    // Anthropic-shortname models (sonnet/haiku/opus) prefer the native
    // ANTHROPIC_* credential, but pi-mono-adapter reroutes through the
    // OpenRouter mirror when only OPENROUTER_API_KEY is available — so the
    // boot-time cred check must accept either key. See task 37a4a87a and
    // the chronic pi-mono → "No API key found for anthropic" recurrence
    // tracked in HEARTBEAT.md (2026-04-13 → 2026-05-11).
    const env = { MODEL_OVERRIDE: "sonnet" };
    expect(
      (
        await checkPiMonoCredentials(
          { ...env, ANTHROPIC_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);
    expect(
      (
        await checkPiMonoCredentials(
          { ...env, OPENROUTER_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);
    // Neither key set → still not ready, and missing includes both options.
    const empty = await checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(empty.ready).toBe(false);
    expect(empty.missing).toContain("ANTHROPIC_API_KEY");
    expect(empty.missing).toContain("OPENROUTER_API_KEY");
  });

  test("haiku and opus shortnames also accept OPENROUTER_API_KEY", async () => {
    for (const model of ["haiku", "opus"]) {
      const env = { MODEL_OVERRIDE: model };
      expect(
        (
          await checkPiMonoCredentials(
            { ...env, OPENROUTER_API_KEY: "x" },
            { homeDir: HOME, fs: noFiles },
          )
        ).ready,
      ).toBe(true);
    }
  });

  // ─── amazon-bedrock prefix inference: probe triggered, result depends on creds ─
  // When BEDROCK_AUTH_MODE is absent and MODEL_OVERRIDE starts with
  // "amazon-bedrock/", the probe runs. Tests inject a stub to avoid hitting AWS.

  test("amazon-bedrock: probe success → ready (sdk-delegated)", async () => {
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeSuccess,
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
    expect(status.missing).toEqual([]);
  });

  test("amazon-bedrock: probe success even when ANTHROPIC_API_KEY also set (Bedrock wins)", async () => {
    // The Anthropic-shape key is irrelevant — model is routed through AWS Bedrock.
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      ANTHROPIC_API_KEY: "x",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeSuccess,
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
  });

  test("amazon-bedrock: probe success even when auth.json exists (Bedrock wins over file)", async () => {
    // auth.json holds Anthropic/OpenRouter/OpenAI creds — none used by Bedrock.
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: fsWith(new Set([AUTH])),
      bedrockProbe: bedrockProbeSuccess,
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
  });

  test("amazon-bedrock: provider-prefix match is case-insensitive", async () => {
    const env = {
      MODEL_OVERRIDE: "Amazon-Bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeSuccess,
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
  });

  test("amazon-bedrock: probe auth failure → ready:false with aws-auth hint", async () => {
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeAuthFail,
    });
    expect(status.ready).toBe(false);
    expect(status.hint).toContain("aws sso login");
  });

  test("amazon-bedrock: probe access failure → ready:false with aws-access hint", async () => {
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeAccessFail,
    });
    expect(status.ready).toBe(false);
    expect(status.hint).toContain("bedrock:InvokeModel");
  });

  test("amazon-bedrock: probe region failure → ready:false (unclassified hint)", async () => {
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeRegionFail,
    });
    expect(status.ready).toBe(false);
    // Not matching a known AWS category → raw probe error surfaced in hint
    expect(status.hint).toBeDefined();
  });

  // ─── BEDROCK_AUTH_MODE=sdk: explicit mode, decoupled from MODEL_OVERRIDE ────

  test("BEDROCK_AUTH_MODE=sdk: probe triggered even without amazon-bedrock/ prefix", async () => {
    // Explicit mode — MODEL_OVERRIDE can be anything (or absent); the Bedrock
    // path is taken because the operator explicitly declared BEDROCK_AUTH_MODE=sdk.
    const env = {
      BEDROCK_AUTH_MODE: "sdk",
      MODEL_OVERRIDE: "some-other-model",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeSuccess,
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
  });

  test("BEDROCK_AUTH_MODE=sdk: probe failure → ready:false", async () => {
    const env = { BEDROCK_AUTH_MODE: "sdk", AWS_REGION: "us-east-1" };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeAuthFail,
    });
    expect(status.ready).toBe(false);
  });

  test("BEDROCK_AUTH_MODE=bearer: does NOT trigger the sdk probe (falls through)", async () => {
    // The bearer path is declared/validated but the full implementation is
    // not implemented yet. With no other credentials set it should be not-ready
    // via the standard permissive check, not via the sdk probe.
    const env = { BEDROCK_AUTH_MODE: "bearer" };
    // No other keys set, no auth.json → not-ready from the permissive path.
    const status = await checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(false);
    // Satisfying via any standard key still works for the bearer mode today.
    const withKey = await checkPiMonoCredentials(
      { BEDROCK_AUTH_MODE: "bearer", ANTHROPIC_API_KEY: "x" },
      { homeDir: HOME, fs: noFiles },
    );
    expect(withKey.ready).toBe(true);
    expect(withKey.satisfiedBy).toBe("env");
  });

  test("BEDROCK_AUTH_MODE absent + no MODEL_OVERRIDE=amazon-bedrock: no probe", async () => {
    // Fallback inference: neither BEDROCK_AUTH_MODE nor an amazon-bedrock MODEL_OVERRIDE
    // → standard permissive path, no AWS call.
    const env = { ANTHROPIC_API_KEY: "x" };
    const status = await checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("env");
  });

  // ─── model enumeration (bedrockModels) ───────────────────────────────────

  test("probe success with model list → bedrockModels populated", async () => {
    const fakeModels = [
      { id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" },
      { id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" },
    ];
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: async () => fakeModels,
    });
    expect(status.ready).toBe(true);
    expect(status.bedrockModels).toEqual(fakeModels);
    expect(status.bedrockRegion).toBe("us-east-1");
  });

  test("probe success with void return → bedrockModels is empty array (backward compat)", async () => {
    // Auth-only stubs return void — should not break enumeration callers.
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeSuccess, // returns void
    });
    expect(status.ready).toBe(true);
    expect(status.bedrockModels).toEqual([]);
  });

  test("probe failure → bedrockModels is empty array and bedrockRegion is set", async () => {
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeAuthFail,
    });
    expect(status.ready).toBe(false);
    expect(status.bedrockModels).toEqual([]);
    expect(status.bedrockRegion).toBe("us-east-1");
  });

  test("probe uses AWS_REGION from env for bedrockRegion", async () => {
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "eu-west-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeSuccess,
    });
    expect(status.bedrockRegion).toBe("eu-west-1");
  });

  // ─── region not fabricated when AWS_REGION is unset ───────────────────────

  test("AWS_REGION unset (sdk mode) → not-ready with set-region hint, no probe, no fabricated region", async () => {
    // No us-east-1 fallback: enumerating a guessed region can differ from where
    // inference runs. The probe must NOT run; report a not-ready Bedrock state.
    let probeCalled = false;
    const env = { BEDROCK_AUTH_MODE: "sdk" };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: async () => {
        probeCalled = true;
        return [];
      },
    });
    expect(probeCalled).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.hint).toContain("AWS_REGION");
    expect(status.bedrockModels).toEqual([]);
    // Empty string sentinel, NOT a fabricated "us-east-1".
    expect(status.bedrockRegion).toBe("");
  });

  test("AWS_REGION unset (prefix inference) → not-ready, bedrock block still reported", async () => {
    const env = { MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0" };
    const status = await checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(false);
    expect(status.bedrockRegion).toBe("");
    expect(status.bedrockRegion).not.toBe("us-east-1");
  });

  test("non-Bedrock path → bedrockModels and bedrockRegion are undefined", async () => {
    // Standard anthropic key path — no Bedrock probe runs.
    const env = { ANTHROPIC_API_KEY: "x" };
    const status = await checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(true);
    expect(status.bedrockModels).toBeUndefined();
    expect(status.bedrockRegion).toBeUndefined();
  });
});

// ─── opencode ────────────────────────────────────────────────────────────────

describe("checkOpencodeCredentials", () => {
  const HOME = "/home/worker";
  const AUTH = `${HOME}/.local/share/opencode/auth.json`;

  test("ready (file) when ~/.local/share/opencode/auth.json exists", () => {
    const status = checkOpencodeCredentials({}, { homeDir: HOME, fs: fsWith(new Set([AUTH])) });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("file");
  });

  test("permissive: ready with any one supported key", () => {
    expect(
      checkOpencodeCredentials({ OPENROUTER_API_KEY: "x" }, { homeDir: HOME, fs: noFiles }).ready,
    ).toBe(true);
  });

  test("strict: MODEL_OVERRIDE=openai/... requires OPENAI_API_KEY", () => {
    const env = { MODEL_OVERRIDE: "openai/gpt-4o" };
    expect(checkOpencodeCredentials(env, { homeDir: HOME, fs: noFiles }).ready).toBe(false);
    expect(
      checkOpencodeCredentials({ ...env, OPENAI_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
        .ready,
    ).toBe(true);
  });

  test("not ready when nothing is set", () => {
    const status = checkOpencodeCredentials({}, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("OPENROUTER_API_KEY");
    expect(status.missing).toContain("ANTHROPIC_API_KEY");
    expect(status.missing).toContain("OPENAI_API_KEY");
    expect(status.missing).toContain(AUTH);
  });
});

// ─── dispatcher ──────────────────────────────────────────────────────────────

describe("checkProviderCredentials dispatcher", () => {
  const HOME = "/home/worker";

  test("dispatches to the right adapter for every supported provider", async () => {
    expect((await checkProviderCredentials("claude", { CLAUDE_CODE_OAUTH_TOKEN: "x" })).ready).toBe(
      true,
    );
    expect((await checkProviderCredentials("claude", {})).ready).toBe(false);

    expect(
      (
        await checkProviderCredentials(
          "claude-managed",
          {
            ANTHROPIC_API_KEY: "x",
            MANAGED_AGENT_ID: "a",
            MANAGED_ENVIRONMENT_ID: "e",
            MCP_BASE_URL: "https://x",
          },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);

    expect(
      (await checkProviderCredentials("devin", { DEVIN_API_KEY: "x", DEVIN_ORG_ID: "y" })).ready,
    ).toBe(true);

    expect(
      (
        await checkProviderCredentials(
          "codex",
          { OPENAI_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);

    expect(
      (
        await checkProviderCredentials(
          "pi",
          { ANTHROPIC_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);

    expect(
      (
        await checkProviderCredentials(
          "opencode",
          { OPENROUTER_API_KEY: "x" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);
  });

  test("throws on unknown provider", async () => {
    expect(checkProviderCredentials("nope", {})).rejects.toThrow(/unknown provider/i);
  });
});

// ─── snapshot tests required by the plan ────────────────────────────────────

describe("snapshot: every provider", () => {
  const HOME = "/home/worker";
  const providers = ["claude", "claude-managed", "codex", "devin", "opencode", "pi"] as const;

  test("fully unset env → ready=false with non-empty missing[] and hint", async () => {
    for (const p of providers) {
      const status = await checkProviderCredentials(p, {}, { homeDir: HOME, fs: noFiles });
      expect(status.ready).toBe(false);
      expect(status.missing.length).toBeGreaterThan(0);
      expect(status.hint).toBeTruthy();
    }
  });

  test("minimum sufficient env → ready=true", async () => {
    const minimums: Record<string, Record<string, string>> = {
      claude: { CLAUDE_CODE_OAUTH_TOKEN: "x" },
      "claude-managed": {
        ANTHROPIC_API_KEY: "x",
        MANAGED_AGENT_ID: "a",
        MANAGED_ENVIRONMENT_ID: "e",
        MCP_BASE_URL: "https://x",
      },
      codex: { OPENAI_API_KEY: "x" },
      devin: { DEVIN_API_KEY: "x", DEVIN_ORG_ID: "y" },
      opencode: { OPENROUTER_API_KEY: "x" },
      pi: { ANTHROPIC_API_KEY: "x" },
    };
    for (const p of providers) {
      const status = await checkProviderCredentials(p, minimums[p]!, {
        homeDir: HOME,
        fs: noFiles,
      });
      expect(status.ready).toBe(true);
    }
  });
});

// ─── REQUIRED_CRED_VARS_BY_PROVIDER documentation map ────────────────────────

describe("REQUIRED_CRED_VARS_BY_PROVIDER", () => {
  test("covers every supported provider", () => {
    const providers = ["claude", "claude-managed", "codex", "devin", "opencode", "pi"] as const;
    for (const p of providers) {
      expect(REQUIRED_CRED_VARS_BY_PROVIDER[p]).toBeDefined();
      expect(REQUIRED_CRED_VARS_BY_PROVIDER[p].length).toBeGreaterThan(0);
    }
  });
});

// ─── Migration 055: report composition + opt-out ────────────────────────────

describe("isCredCheckDisabled", () => {
  test("true only when CRED_CHECK_DISABLE === '1'", () => {
    expect(isCredCheckDisabled({})).toBe(false);
    expect(isCredCheckDisabled({ CRED_CHECK_DISABLE: "0" })).toBe(false);
    expect(isCredCheckDisabled({ CRED_CHECK_DISABLE: "true" })).toBe(false);
    expect(isCredCheckDisabled({ CRED_CHECK_DISABLE: "1" })).toBe(true);
  });
});

describe("buildCredStatusReport", () => {
  test("not ready → no live test, snapshot mirrors presence check", async () => {
    const snap = await buildCredStatusReport("claude", {}, {}, "boot");
    expect(snap.ready).toBe(false);
    expect(snap.liveTest).toBeNull();
    expect(snap.reportKind).toBe("boot");
    expect(snap.missing.length).toBeGreaterThan(0);
  });

  test("post_task kind is preserved on the snapshot", async () => {
    const snap = await buildCredStatusReport("claude", {}, {}, "post_task");
    expect(snap.reportKind).toBe("post_task");
  });

  // bedrock block in AgentCredStatus
  test("Bedrock SDK mode: bedrock block included with live model list", async () => {
    const fakeModels = [{ id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" }];
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const snap = await buildCredStatusReport(
      "pi",
      env,
      { bedrockProbe: async () => fakeModels },
      "boot",
    );
    expect(snap.ready).toBe(true);
    expect(snap.bedrock).not.toBeNull();
    expect(snap.bedrock?.ready).toBe(true);
    expect(snap.bedrock?.models).toEqual(fakeModels);
    expect(snap.bedrock?.region).toBe("us-east-1");
    expect(typeof snap.bedrock?.probedAt).toBe("number");
  });

  test("Bedrock SDK mode: probe failure → bedrock block has ready:false and empty models", async () => {
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      AWS_REGION: "us-east-1",
    };
    const snap = await buildCredStatusReport(
      "pi",
      env,
      { bedrockProbe: bedrockProbeAuthFail },
      "boot",
    );
    expect(snap.ready).toBe(false);
    expect(snap.bedrock).not.toBeNull();
    expect(snap.bedrock?.ready).toBe(false);
    expect(snap.bedrock?.models).toEqual([]);
    expect(snap.bedrock?.error).toBeTruthy();
  });

  test("non-Bedrock pi mode → bedrock block is null", async () => {
    const HOME = "/home/worker";
    const snap = await buildCredStatusReport(
      "pi",
      { ANTHROPIC_API_KEY: "x" },
      { homeDir: HOME, fs: noFiles },
      "boot",
    );
    expect(snap.bedrock).toBeNull();
  });

  test("non-pi provider → bedrock block is null", async () => {
    const snap = await buildCredStatusReport(
      "claude",
      { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      {},
      "boot",
    );
    expect(snap.bedrock).toBeNull();
  });
});

// ─── schema round-trip ───────────────────────────────────────────────────────

describe("AgentCredStatusSchema round-trip with bedrock block", () => {
  test("full bedrock block parses and serializes cleanly", () => {
    const raw = {
      ready: true,
      missing: [],
      satisfiedBy: "sdk-delegated",
      hint: "AWS SDK credentials verified via ListFoundationModels (region: us-east-1).",
      liveTest: null,
      latestModel: null,
      reportedAt: Date.now(),
      reportKind: "boot",
      bedrock: {
        region: "us-east-1",
        probedAt: Date.now(),
        ready: true,
        models: [
          { id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" },
          { id: "anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5" },
        ],
      },
    };
    const parsed = AgentCredStatusSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bedrock?.models).toHaveLength(2);
      expect(parsed.data.bedrock?.ready).toBe(true);
      expect(parsed.data.bedrock?.region).toBe("us-east-1");
    }
  });

  test("bedrock block absent → defaults to null (backward compat)", () => {
    const raw = {
      ready: true,
      missing: [],
      satisfiedBy: "env",
      hint: null,
      liveTest: null,
      latestModel: null,
      reportedAt: Date.now(),
      reportKind: "boot",
      // No bedrock field
    };
    const parsed = AgentCredStatusSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bedrock).toBeNull();
    }
  });

  test("bedrock block with error field parses correctly", () => {
    const raw = {
      ready: false,
      missing: [],
      satisfiedBy: null,
      hint: "ExpiredToken",
      liveTest: null,
      latestModel: null,
      reportedAt: Date.now(),
      reportKind: "boot",
      bedrock: {
        region: "us-east-1",
        probedAt: Date.now(),
        ready: false,
        models: [],
        error: "Token expired — run aws sso login",
      },
    };
    const parsed = AgentCredStatusSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.bedrock?.ready).toBe(false);
      expect(parsed.data.bedrock?.error).toBeDefined();
      expect(parsed.data.bedrock?.models).toEqual([]);
    }
  });
});

// ─── usable set = harness-drivable ∩ (ON_DEMAND/ACTIVE FMs ∪ inference profiles) ─
// The real intersection lives in `runBedrockSdkProbeAndEnumerate`, which the
// injectable `bedrockProbe` stub bypasses. To exercise the union + filtering +
// intersection without real AWS credentials, stub `@aws-sdk/client-bedrock` and
// feed it canned list responses built from REAL pi-ai catalog ids.

describe("runBedrockSdkProbeAndEnumerate — intersection logic", () => {
  test("includes inference-profile ids; drops non-ACTIVE and non-drivable ids", async () => {
    const { getBuiltinModels: getModels } = await import("@earendil-works/pi-ai/providers/all");
    const drivable = getModels("amazon-bedrock");
    const isProfile = (id: string) => /^(us|eu|apac|au|global)\./.test(id);
    const baseModel = drivable.find((m) => !isProfile(m.id));
    const profileModel = drivable.find((m) => isProfile(m.id));
    const legacyDrivable = drivable.find(
      (m) => m.id !== baseModel?.id && m.id !== profileModel?.id,
    );
    if (!baseModel || !profileModel || !legacyDrivable) {
      throw new Error("pi-ai amazon-bedrock catalog missing expected shapes");
    }

    // Capture which command kinds the client was asked to send.
    const sentKinds: string[] = [];
    mock.module("@aws-sdk/client-bedrock", () => ({
      BedrockClient: class {
        async send(cmd: { __kind: string }) {
          sentKinds.push(cmd.__kind);
          if (cmd.__kind === "fm") {
            return {
              modelSummaries: [
                // ON_DEMAND/TEXT (request-filtered) + ACTIVE → kept.
                { modelId: baseModel.id, modelLifecycle: { status: "ACTIVE" } },
                // Drivable but NOT ACTIVE → dropped by lifecycle filter.
                { modelId: legacyDrivable.id, modelLifecycle: { status: "LEGACY" } },
                // ACTIVE but NOT in the pi-ai catalog → dropped by intersection.
                { modelId: "amazon.not-a-real-pi-id-v9:0", modelLifecycle: { status: "ACTIVE" } },
              ],
            };
          }
          return {
            inferenceProfileSummaries: [
              // Cross-region profile id present in the pi-ai catalog → kept.
              // This is exactly the class the old base-only intersection dropped.
              { inferenceProfileId: profileModel.id },
              // Profile id NOT in the pi-ai catalog → dropped by intersection.
              { inferenceProfileId: "us.vendor.unknown-profile-v1:0" },
            ],
          };
        }
      },
      ListFoundationModelsCommand: class {
        __kind = "fm";
        constructor(public input: unknown) {}
      },
      ListInferenceProfilesCommand: class {
        __kind = "ip";
        constructor(public input: unknown) {}
      },
    }));

    const { runBedrockSdkProbeAndEnumerate } = await import("../providers/pi-mono-adapter");
    const usable = await runBedrockSdkProbeAndEnumerate("us-east-1");
    const ids = usable.map((m) => m.id);

    // Both list calls were made (single bounded round-trip each).
    expect(sentKinds).toContain("fm");
    expect(sentKinds).toContain("ip");
    // Base ACTIVE model kept.
    expect(ids).toContain(baseModel.id);
    // Inference-profile model kept — the regression this fix targets.
    expect(ids).toContain(profileModel.id);
    // Non-ACTIVE drivable dropped; non-catalog ids dropped.
    expect(ids).not.toContain(legacyDrivable.id);
    expect(ids).not.toContain("amazon.not-a-real-pi-id-v9:0");
    expect(ids).not.toContain("us.vendor.unknown-profile-v1:0");
    // Stored ids are pi-ai ids carrying the catalog name.
    expect(usable.find((m) => m.id === profileModel.id)?.name).toBe(profileModel.name);

    mock.restore();
  });
});
