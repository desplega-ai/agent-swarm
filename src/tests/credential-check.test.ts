import { describe, expect, test } from "bun:test";
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

describe("checkPiMonoCredentials", () => {
  const HOME = "/home/worker";
  const AUTH = `${HOME}/.pi/agent/auth.json`;

  test("ready (file) when ~/.pi/agent/auth.json exists", () => {
    const status = checkPiMonoCredentials({}, { homeDir: HOME, fs: fsWith(new Set([AUTH])) });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("file");
  });

  test("permissive: ready when MODEL_OVERRIDE unset and any one supported key is present", () => {
    expect(
      checkPiMonoCredentials({ ANTHROPIC_API_KEY: "x" }, { homeDir: HOME, fs: noFiles }).ready,
    ).toBe(true);
    expect(
      checkPiMonoCredentials({ OPENROUTER_API_KEY: "x" }, { homeDir: HOME, fs: noFiles }).ready,
    ).toBe(true);
    expect(
      checkPiMonoCredentials({ OPENAI_API_KEY: "x" }, { homeDir: HOME, fs: noFiles }).ready,
    ).toBe(true);
  });

  test("permissive: not ready when MODEL_OVERRIDE unset and no keys are set", () => {
    const status = checkPiMonoCredentials({}, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("ANTHROPIC_API_KEY");
    expect(status.missing).toContain("OPENROUTER_API_KEY");
    expect(status.missing).toContain("OPENAI_API_KEY");
  });

  test("strict: MODEL_OVERRIDE=anthropic/... requires ANTHROPIC_API_KEY", () => {
    const env = { MODEL_OVERRIDE: "anthropic/claude-sonnet-4" };
    expect(checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles }).ready).toBe(false);
    expect(
      checkPiMonoCredentials({ ...env, ANTHROPIC_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
        .ready,
    ).toBe(true);
    // OPENROUTER_API_KEY does NOT satisfy an anthropic-prefixed model
    expect(
      checkPiMonoCredentials({ ...env, OPENROUTER_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
        .ready,
    ).toBe(false);
  });

  test("strict: MODEL_OVERRIDE=openrouter/... requires OPENROUTER_API_KEY", () => {
    const env = { MODEL_OVERRIDE: "openrouter/google/gemini-2.5-flash-lite" };
    expect(
      checkPiMonoCredentials({ ...env, OPENROUTER_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
        .ready,
    ).toBe(true);
    expect(
      checkPiMonoCredentials({ ...env, ANTHROPIC_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
        .ready,
    ).toBe(false);
  });

  test("shortname `sonnet` accepts ANTHROPIC_API_KEY *or* OPENROUTER_API_KEY", () => {
    // Anthropic-shortname models (sonnet/haiku/opus) prefer the native
    // ANTHROPIC_* credential, but pi-mono-adapter reroutes through the
    // OpenRouter mirror when only OPENROUTER_API_KEY is available — so the
    // boot-time cred check must accept either key. See task 37a4a87a and
    // the chronic pi-mono → "No API key found for anthropic" recurrence
    // tracked in HEARTBEAT.md (2026-04-13 → 2026-05-11).
    const env = { MODEL_OVERRIDE: "sonnet" };
    expect(
      checkPiMonoCredentials({ ...env, ANTHROPIC_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
        .ready,
    ).toBe(true);
    expect(
      checkPiMonoCredentials({ ...env, OPENROUTER_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
        .ready,
    ).toBe(true);
    // Neither key set → still not ready, and missing includes both options.
    const empty = checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(empty.ready).toBe(false);
    expect(empty.missing).toContain("ANTHROPIC_API_KEY");
    expect(empty.missing).toContain("OPENROUTER_API_KEY");
  });

  test("haiku and opus shortnames also accept OPENROUTER_API_KEY", () => {
    for (const model of ["haiku", "opus"]) {
      const env = { MODEL_OVERRIDE: model };
      expect(
        checkPiMonoCredentials({ ...env, OPENROUTER_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
          .ready,
      ).toBe(true);
    }
  });

  // ─── amazon-bedrock: AWS SDK delegates credential resolution ───────────────
  // When MODEL_OVERRIDE selects amazon-bedrock, pi-mono routes through the AWS
  // SDK's default credential chain (env, ~/.aws/*, SSO, IMDS, assume-role,
  // web-identity, …). agent-swarm does no presence check beyond detecting the
  // `amazon-bedrock/` prefix — the SDK validates at first inference call.
  // Mirrors the codex auth.json "presence-only" pattern.

  test("amazon-bedrock: ready (sdk-delegated) with no env vars and no auth.json", () => {
    const env = { MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0" };
    const status = checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
    expect(status.missing).toEqual([]);
  });

  test("amazon-bedrock: stays sdk-delegated even when ANTHROPIC_API_KEY is also set", () => {
    // The Anthropic-shape key is irrelevant here — the model is routed through
    // AWS Bedrock, not Anthropic. Reporting satisfiedBy="env" would mislead.
    const env = {
      MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0",
      ANTHROPIC_API_KEY: "x",
    };
    const status = checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
  });

  test("amazon-bedrock: stays sdk-delegated even when auth.json exists", () => {
    // auth.json holds Anthropic/OpenRouter/OpenAI creds — none used by Bedrock.
    // Bedrock branch must win over the file probe.
    const env = { MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude-sonnet-4-20250514-v1:0" };
    const status = checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: fsWith(new Set([AUTH])),
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
  });

  test("amazon-bedrock: provider-prefix match is case-insensitive", () => {
    // Mirrors modelToCredKeys' .toLowerCase() at line 54 of pi-mono-adapter.
    const env = { MODEL_OVERRIDE: "Amazon-Bedrock/anthropic.claude-sonnet-4-20250514-v1:0" };
    const status = checkPiMonoCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("sdk-delegated");
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

    const acpStatus = await checkProviderCredentials("acp", {}, { homeDir: HOME, fs: noFiles });
    expect(acpStatus.ready).toBe(true);
    expect(acpStatus.satisfiedBy).toBe("sdk-delegated");
  });

  test("checks Gemini CLI credentials when acp target is gemini-cli", async () => {
    const missing = await checkProviderCredentials(
      "acp",
      { ACP_TARGET: "gemini-cli" },
      { homeDir: HOME, fs: noFiles },
    );
    expect(missing.ready).toBe(false);
    expect(missing.missing).toContain("GEMINI_API_KEY");
    expect(missing.hint).toContain("gemini-cli");

    expect(
      (
        await checkProviderCredentials(
          "acp",
          { ACP_TARGET: "gemini-cli", GEMINI_API_KEY: "key" },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);

    expect(
      (
        await checkProviderCredentials(
          "acp",
          {
            ACP_TARGET: "gemini-cli",
            GOOGLE_GENAI_USE_VERTEXAI: "true",
            GOOGLE_APPLICATION_CREDENTIALS: "/creds.json",
            GOOGLE_CLOUD_PROJECT: "project",
            GOOGLE_CLOUD_LOCATION: "us-central1",
          },
          { homeDir: HOME, fs: noFiles },
        )
      ).ready,
    ).toBe(true);

    const withOAuthFile = await checkProviderCredentials(
      "acp",
      { ACP_TARGET: "gemini-cli" },
      {
        homeDir: HOME,
        fs: fsWith(new Set([`${HOME}/.gemini/oauth_creds.json`])),
      },
    );
    expect(withOAuthFile.ready).toBe(true);
    expect(withOAuthFile.satisfiedBy).toBe("file");
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
    const providers = [
      "claude",
      "claude-managed",
      "codex",
      "devin",
      "opencode",
      "pi",
      "acp",
    ] as const;
    for (const p of providers) {
      expect(REQUIRED_CRED_VARS_BY_PROVIDER[p]).toBeDefined();
    }
    expect(REQUIRED_CRED_VARS_BY_PROVIDER.acp[0]).toContain("target-specific");
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
});
