import { afterEach, describe, expect, mock, test } from "bun:test";
import { OPENAI_COMPATIBLE_PROVIDERS } from "@desplega/model-catalog";
import {
  buildCredStatusReport,
  CREDENTIAL_PROVIDER_CHECKERS,
  checkEachKey,
  checkOpenAICompatibleProvider,
  checkProviderCredentials,
  isBedrockMode,
  isCredCheckDisabled,
  REQUIRED_CRED_VARS_BY_PROVIDER,
  shouldRefreshBedrockStatus,
  validateProviderCredentials,
} from "../commands/provider-credentials";
import { ACP_TARGET_IDS } from "../providers/acp-target-catalog";
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

describe("pool live test", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("all members pass in parallel with the maximum latency", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check = mock(async (key: string) => {
      await gate;
      return { ok: true, latency_ms: key === "fake-abcde" ? 30 : 10 };
    });
    const pending = checkEachKey("OPENAI_API_KEY", " fake-abcde, fake-fghij ", check);
    expect(check).toHaveBeenCalledTimes(2);
    release();
    expect(await pending).toEqual({
      ok: true,
      latency_ms: 30,
      keys: [
        { keyType: "OPENAI_API_KEY", index: 0, suffix: "abcde", ok: true, latency_ms: 30 },
        { keyType: "OPENAI_API_KEY", index: 1, suffix: "fghij", ok: true, latency_ms: 10 },
      ],
    });
  });

  test("one failed member preserves pool order and reports a warning", async () => {
    const result = await checkEachKey(
      "ANTHROPIC_API_KEY",
      "fake-first,fake-abcde,fake-third",
      async (key) =>
        key === "fake-abcde"
          ? { ok: false, error: "Unauthorized", httpStatus: 401, latency_ms: 20 }
          : { ok: true, latency_ms: 10 },
    );
    expect(result).toMatchObject({
      ok: true,
      latency_ms: 20,
      warning: "1 of 3 keys failed: key ending abcde (HTTP 401).",
    });
    expect(result.keys).toEqual([
      { keyType: "ANTHROPIC_API_KEY", index: 0, suffix: "first", ok: true, latency_ms: 10 },
      {
        keyType: "ANTHROPIC_API_KEY",
        index: 1,
        suffix: "abcde",
        ok: false,
        error: "Unauthorized",
        httpStatus: 401,
        latency_ms: 20,
      },
      { keyType: "ANTHROPIC_API_KEY", index: 2, suffix: "third", ok: true, latency_ms: 10 },
    ]);
    expect(result.error).toBeUndefined();
  });

  test("several failed members use HTTP status or the member error", async () => {
    const result = await checkEachKey(
      "OPENAI_API_KEY",
      "fake-abcde,fake-fghij,fake-third",
      async (key) => {
        if (key === "fake-abcde") {
          return { ok: false, error: "Unauthorized", httpStatus: 401, latency_ms: 10 };
        }
        if (key === "fake-fghij") return { ok: false, error: "timeout", latency_ms: 30 };
        return { ok: true, latency_ms: 20 };
      },
    );
    expect(result.ok).toBe(true);
    expect(result.warning).toBe(
      "2 of 3 keys failed: key ending abcde (HTTP 401), key ending fghij (timeout).",
    );
    expect(result.latency_ms).toBe(30);
  });

  test("all failed members produce an error", async () => {
    const result = await checkEachKey("OPENAI_API_KEY", "fake-abcde,fake-fghij", async () => ({
      ok: false,
      error: "Unauthorized",
      httpStatus: 401,
      latency_ms: 10,
    }));
    expect(result).toMatchObject({
      ok: false,
      error: "All 2 keys failed: key ending abcde (HTTP 401), key ending fghij (HTTP 401).",
      latency_ms: 10,
    });
    expect(result.keys).toHaveLength(2);
    expect(result.warning).toBeUndefined();
    expect(result.httpStatus).toBeUndefined();
  });

  test("one failed key preserves the member error and HTTP status", async () => {
    const result = await checkEachKey("OPENAI_API_KEY", "fake-abcde", async () => ({
      ok: false,
      error: "HTTP 401: rejected",
      httpStatus: 401,
      latency_ms: 10,
    }));
    expect(result).toMatchObject({
      ok: false,
      error: "HTTP 401: rejected",
      httpStatus: 401,
      latency_ms: 10,
    });
    expect(result.keys).toHaveLength(1);
  });

  test("a thrown check becomes a scrubbed member failure", async () => {
    const result = await checkEachKey("OPENAI_API_KEY", "fake-abcde,fake-fghij", async (key) => {
      if (key === "fake-abcde") throw new Error("timeout");
      return { ok: true, latency_ms: 0 };
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBe("1 of 2 keys failed: key ending abcde (timeout).");
    expect(result.keys?.[0]).toMatchObject({ ok: false, error: "timeout" });
    expect(result.keys?.[0]?.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test("a CODEX_OAUTH JSON blob remains one member", async () => {
    const blob = '{"access":"fake-access","refresh":"fake-refresh","expires":123}';
    const check = mock(async () => ({ ok: true, latency_ms: 0 }));
    const result = await checkEachKey("CODEX_OAUTH", ` ${blob} `, check);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(blob);
    expect(result.keys).toHaveLength(1);
    expect(result.keys?.[0]?.suffix).toBe(blob.slice(-5));
  });

  test("an empty split checks the trimmed input once", async () => {
    const check = mock(async () => ({ ok: false, error: "Missing key", latency_ms: 0 }));
    const result = await checkEachKey("OPENAI_API_KEY", " , , ", check);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(", ,");
    expect(result.error).toBe("Missing key");
  });

  test("all configured members skip the live test", async () => {
    const result = await checkEachKey("ANTHROPIC_API_KEY", "fake-abcde,fake-fghij", async () => ({
      ok: true,
      skipped: true,
      latency_ms: 10,
    }));
    expect(result).toEqual({ ok: true, skipped: true, latency_ms: 10 });
  });

  test("Claude API-key pools send a separate request for each member", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-api-key");
      return new Response("{}", { status: key === "fake-good1" ? 200 : 401 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await validateProviderCredentials("claude", {
      ANTHROPIC_API_KEY: "fake-good1,fake-bad01",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("x-api-key")),
    ).toEqual(["fake-good1", "fake-bad01"]);
    expect(result.ok).toBe(true);
    expect(result.warning).toBe("1 of 2 keys failed: key ending bad01 (HTTP 401).");
    expect(result.keys?.[1]?.httpStatus).toBe(401);
  });

  test("Claude subscription pools check the OAuth profile for each member", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await validateProviderCredentials("claude", {
      CLAUDE_CODE_OAUTH_TOKEN: "fake-token-a,fake-token-b",
    });
    expect(result.ok).toBe(true);
    expect(result.keys).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("https://api.anthropic.com/api/oauth/profile");
      expect(init?.method).toBe("GET");
    }
    expect(
      fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual(["Bearer fake-token-a", "Bearer fake-token-b"]);
  });

  test("buildCredStatusReport copies the warning and per-key results", async () => {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const key = new Headers(init?.headers).get("x-api-key");
      return new Response("{}", { status: key === "fake-good1" ? 200 : 401 });
    }) as typeof fetch;
    const report = await buildCredStatusReport(
      "claude",
      { ANTHROPIC_API_KEY: "fake-good1,fake-bad01" },
      {},
      "boot",
    );
    expect(report.liveTest?.warning).toBe("1 of 2 keys failed: key ending bad01 (HTTP 401).");
    expect(report.liveTest?.keys).toEqual([
      {
        keyType: "ANTHROPIC_API_KEY",
        index: 0,
        suffix: "good1",
        ok: true,
        latency_ms: expect.any(Number),
      },
      {
        keyType: "ANTHROPIC_API_KEY",
        index: 1,
        suffix: "bad01",
        ok: false,
        error: "HTTP 401: {}",
        httpStatus: 401,
        latency_ms: expect.any(Number),
      },
    ]);
    expect(AgentCredStatusSchema.parse(report).liveTest).toEqual(report.liveTest);
    const success = await buildCredStatusReport(
      "claude",
      { ANTHROPIC_API_KEY: "fake-good1" },
      {},
      "boot",
    );
    expect(success.liveTest).not.toHaveProperty("warning");
    const presenceOnly = await buildCredStatusReport(
      "acp",
      { ACP_COMMAND: "fake-command" },
      {},
      "boot",
    );
    expect(presenceOnly.liveTest).not.toHaveProperty("warning");
    expect(presenceOnly.liveTest).not.toHaveProperty("keys");
  });
});

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

  test("strict: MODEL_OVERRIDE=opencode-go/... requires OPENCODE_API_KEY", async () => {
    const env = { MODEL_OVERRIDE: "opencode-go/deepseek-v4.1-flash" };
    expect(
      (
        await checkPiMonoCredentials(
          { ...env, OPENCODE_API_KEY: "x" },
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

  test("strict: MODEL_OVERRIDE=google/... accepts GEMINI_API_KEY", async () => {
    const env = {
      MODEL_OVERRIDE: "google/gemini-3-flash-preview",
      GEMINI_API_KEY: "x",
    };

    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
    });

    expect(status.ready).toBe(true);
    expect(status.missing).toEqual([]);
    expect(status.satisfiedBy).toBe("env");
  });

  test("strict: MODEL_OVERRIDE=google/... lists both Google credential options when missing", async () => {
    const env = {
      MODEL_OVERRIDE: "google/gemini-3-flash-preview",
    };

    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
    });

    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["GOOGLE_API_KEY", "GEMINI_API_KEY", AUTH]);
    expect(status.hint).toContain("GOOGLE_API_KEY / GEMINI_API_KEY");
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

  // ─── BEDROCK_AUTH_MODE=bearer: explicit Bedrock API key ─────────────────────

  test("BEDROCK_AUTH_MODE=bearer: missing AWS_BEARER_TOKEN_BEDROCK → not ready, no probe, no fall-through", async () => {
    let probed = false;
    // A standard key must not satisfy the bearer mode: it does not apply to Bedrock.
    const env = { BEDROCK_AUTH_MODE: "bearer", AWS_REGION: "us-east-1", ANTHROPIC_API_KEY: "x" };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: async () => {
        probed = true;
      },
    });
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["AWS_BEARER_TOKEN_BEDROCK"]);
    expect(status.hint).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(probed).toBe(false);
  });

  test("BEDROCK_AUTH_MODE=bearer: token without AWS_REGION → not ready with the region hint", async () => {
    const env = { BEDROCK_AUTH_MODE: "bearer", AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key" };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeSuccess,
    });
    expect(status.ready).toBe(false);
    expect(status.hint).toContain("AWS_REGION");
    expect(status.bedrockRegion).toBe("");
  });

  test("BEDROCK_AUTH_MODE=bearer: token + region → probe runs, ready via env", async () => {
    const env = {
      BEDROCK_AUTH_MODE: "bearer",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key",
      AWS_REGION: "eu-central-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: async () => [{ id: "anthropic.claude-sonnet", name: "Claude Sonnet" }],
    });
    expect(status.ready).toBe(true);
    expect(status.satisfiedBy).toBe("env");
    expect(status.bedrockRegion).toBe("eu-central-1");
    expect(status.bedrockModels).toEqual([
      { id: "anthropic.claude-sonnet", name: "Claude Sonnet" },
    ]);
  });

  test("BEDROCK_AUTH_MODE=bearer: probe failure → ready:false with the classified hint", async () => {
    const env = {
      BEDROCK_AUTH_MODE: "bearer",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key",
      AWS_REGION: "us-east-1",
    };
    const status = await checkPiMonoCredentials(env, {
      homeDir: HOME,
      fs: noFiles,
      bedrockProbe: bedrockProbeAuthFail,
    });
    expect(status.ready).toBe(false);
    expect(status.bedrockRegion).toBe("us-east-1");
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

  test("strict: nan/* needs NAN_API_KEY or its HELMCODE_API_NAN alias", () => {
    const env = { MODEL_OVERRIDE: "nan/glm5.3-flash", OPENROUTER_API_KEY: "x" };
    const missing = checkOpencodeCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(missing.ready).toBe(false);
    expect(missing.missing).toContain("NAN_API_KEY");
    for (const name of ["NAN_API_KEY", "HELMCODE_API_NAN"]) {
      expect(
        checkOpencodeCredentials({ ...env, [name]: "x" }, { homeDir: HOME, fs: noFiles }).ready,
      ).toBe(true);
    }
  });

  test("strict: helmcode/* needs HELMCODE_API_KEY, not the NaN alias", () => {
    const env = { MODEL_OVERRIDE: "helmcode/glm5.3", HELMCODE_API_NAN: "x" };
    const missing = checkOpencodeCredentials(env, { homeDir: HOME, fs: noFiles });
    expect(missing.ready).toBe(false);
    expect(missing.missing).toContain("HELMCODE_API_KEY");
    expect(
      checkOpencodeCredentials({ ...env, HELMCODE_API_KEY: "x" }, { homeDir: HOME, fs: noFiles })
        .ready,
    ).toBe(true);
  });

  test("permissive: a NaN or Helmcode key alone is enough", () => {
    for (const name of ["NAN_API_KEY", "HELMCODE_API_NAN", "HELMCODE_API_KEY"]) {
      expect(checkOpencodeCredentials({ [name]: "x" }, { homeDir: HOME, fs: noFiles }).ready).toBe(
        true,
      );
    }
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

describe("ACP readiness", () => {
  test.each(["typo", "", " \t "])("rejects unsupported target %j", async (target) => {
    const status = await checkProviderCredentials("acp", {
      ACP_TARGET: target,
      ACP_TARGET_COMMAND: "custom-acp --stdio",
    });
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["ACP_TARGET"]);
    expect(status.hint).toContain("ACP_TARGET");
    for (const supported of ACP_TARGET_IDS) expect(status.hint).toContain(supported);
  });

  test.each([undefined, "custom"])("requires a command for target %s", async (target) => {
    const status = await CREDENTIAL_PROVIDER_CHECKERS.acp({ ACP_TARGET: target });
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["ACP_TARGET_COMMAND"]);
    expect(status.hint).toContain("ACP_TARGET_COMMAND");
    expect(status.hint).toContain("ACP_COMMAND");
  });

  test.each(["", " \t "])("rejects a blank custom command %j", async (command) => {
    const status = await checkProviderCredentials("acp", {
      ACP_TARGET: "custom",
      ACP_TARGET_COMMAND: command,
      ACP_COMMAND: "legacy-acp",
    });
    expect(status.ready).toBe(false);
    expect(status.missing).toEqual(["ACP_TARGET_COMMAND"]);
  });

  test.each(["ACP_TARGET_COMMAND", "ACP_COMMAND"])("accepts a command from %s", async (key) => {
    for (const target of [undefined, "custom"]) {
      const status = await checkProviderCredentials("acp", {
        ACP_TARGET: target,
        [key]: "custom-acp --stdio",
      });
      expect(status).toEqual({ ready: true, missing: [], satisfiedBy: "sdk-delegated" });
    }
  });

  test.each(
    ACP_TARGET_IDS.filter((target) => target !== "custom"),
  )("keeps preset %s ready without a custom command", async (target) => {
    const status = await checkProviderCredentials("acp", { ACP_TARGET: target });
    expect(status).toEqual({ ready: true, missing: [], satisfiedBy: "sdk-delegated" });
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

    const acpStatus = await checkProviderCredentials("acp", { ACP_TARGET: "opencode" });
    expect(acpStatus.ready).toBe(true);
    expect(acpStatus.satisfiedBy).toBe("sdk-delegated");
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

describe("isBedrockMode (shared gate for the live test and the refresh loop)", () => {
  test("recognizes both explicit modes and the MODEL_OVERRIDE prefix inference", () => {
    expect(isBedrockMode({ BEDROCK_AUTH_MODE: "sdk" })).toBe(true);
    expect(isBedrockMode({ BEDROCK_AUTH_MODE: "bearer" })).toBe(true);
    expect(isBedrockMode({ BEDROCK_AUTH_MODE: "Bearer", MODEL_OVERRIDE: "some-model" })).toBe(true);
    expect(isBedrockMode({ MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude" })).toBe(true);
    expect(isBedrockMode({ MODEL_OVERRIDE: "anthropic/claude" })).toBe(false);
    expect(isBedrockMode({})).toBe(false);
  });
});

describe("shouldRefreshBedrockStatus (runner post-task refresh gate)", () => {
  const INTERVAL = 5 * 60 * 1000;
  const base = { harnessProvider: "pi", lastRefreshAt: 1_000, intervalMs: INTERVAL };

  test("bearer-only pi configuration is refreshed once the interval has elapsed", () => {
    const env = {
      BEDROCK_AUTH_MODE: "bearer",
      AWS_BEARER_TOKEN_BEDROCK: "tok",
      AWS_REGION: "us-east-1",
    };
    expect(shouldRefreshBedrockStatus({ ...base, env, now: 1_000 + INTERVAL + 1 })).toBe(true);
  });

  test("bearer mode stays throttled inside the interval", () => {
    const env = {
      BEDROCK_AUTH_MODE: "bearer",
      AWS_BEARER_TOKEN_BEDROCK: "tok",
      AWS_REGION: "us-east-1",
    };
    expect(shouldRefreshBedrockStatus({ ...base, env, now: 1_000 + INTERVAL })).toBe(false);
    expect(shouldRefreshBedrockStatus({ ...base, env, now: 1_000 + 1 })).toBe(false);
  });

  test("sdk mode and the amazon-bedrock/ prefix inference refresh the same way", () => {
    const now = 1_000 + INTERVAL + 1;
    expect(shouldRefreshBedrockStatus({ ...base, env: { BEDROCK_AUTH_MODE: "sdk" }, now })).toBe(
      true,
    );
    expect(
      shouldRefreshBedrockStatus({
        ...base,
        env: { MODEL_OVERRIDE: "amazon-bedrock/anthropic.claude" },
        now,
      }),
    ).toBe(true);
  });

  test("never fires outside Bedrock mode or for a non-pi harness", () => {
    const now = 1_000 + INTERVAL + 1;
    expect(shouldRefreshBedrockStatus({ ...base, env: { ANTHROPIC_API_KEY: "sk" }, now })).toBe(
      false,
    );
    expect(
      shouldRefreshBedrockStatus({ ...base, env: { MODEL_OVERRIDE: "anthropic/claude" }, now }),
    ).toBe(false);
    expect(
      shouldRefreshBedrockStatus({
        ...base,
        harnessProvider: "claude",
        env: { BEDROCK_AUTH_MODE: "bearer" },
        now,
      }),
    ).toBe(false);
  });
});

describe("validateProviderCredentials: pi Bedrock pass-through", () => {
  const saved = { ...process.env };
  const restore = () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };

  test("bearer mode is a pass-through like sdk mode: no provider-key live test is issued", async () => {
    const realFetch = globalThis.fetch;
    // A stray provider key must not be live-tested: the Bedrock enumeration already ran.
    process.env.BEDROCK_AUTH_MODE = "bearer";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-api-key";
    process.env.ANTHROPIC_API_KEY = "x";
    globalThis.fetch = (async () => {
      throw new Error("live test must not reach the network in Bedrock mode");
    }) as typeof fetch;
    try {
      expect(await validateProviderCredentials("pi")).toEqual({ ok: true, latency_ms: 0 });
    } finally {
      globalThis.fetch = realFetch;
      restore();
    }
  });
});

describe("REQUIRED_CRED_VARS_BY_PROVIDER", () => {
  test("covers every supported provider", () => {
    const providers = ["claude", "claude-managed", "codex", "devin", "opencode", "pi"] as const;
    for (const p of providers) {
      expect(REQUIRED_CRED_VARS_BY_PROVIDER[p]).toBeDefined();
      expect(REQUIRED_CRED_VARS_BY_PROVIDER[p].length).toBeGreaterThan(0);
    }
    // acp is credential-free by design: the target process owns its own auth.
    expect(REQUIRED_CRED_VARS_BY_PROVIDER.acp).toEqual([]);
  });

  test("pi and opencode list the NaN (both names) and Helmcode key vars", () => {
    for (const p of ["pi", "opencode"] as const) {
      expect(REQUIRED_CRED_VARS_BY_PROVIDER[p]).toEqual(
        expect.arrayContaining(["NAN_API_KEY", "HELMCODE_API_NAN", "HELMCODE_API_KEY"]),
      );
    }
  });
});

describe("NaN and Helmcode live probes", () => {
  const envReady = { ready: true, missing: [], satisfiedBy: "env" as const };

  function fakeProvider(status: number) {
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({
          path: new URL(req.url).pathname,
          authorization: req.headers.get("authorization"),
        });
        return new Response(status === 200 ? '{"data":[]}' : '{"error":"Invalid API key."}', {
          status,
        });
      },
    });
    return { server, seen, baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1` };
  }

  for (const [name, probe] of [
    [
      "nan",
      (key: string, url: string) =>
        checkOpenAICompatibleProvider(OPENAI_COMPATIBLE_PROVIDERS.nan, key, url),
    ],
    [
      "helmcode",
      (key: string, url: string) =>
        checkOpenAICompatibleProvider(OPENAI_COMPATIBLE_PROVIDERS.helmcode, key, url),
    ],
  ] as const) {
    test(`${name} probe lists models with a Bearer key at the injected base URL`, async () => {
      const ok = fakeProvider(200);
      const bad = fakeProvider(401);
      try {
        expect(await probe("fixture-key", `${ok.baseUrl}/`)).toMatchObject({ ok: true });
        expect(ok.seen).toEqual([{ path: "/v1/models", authorization: "Bearer fixture-key" }]);
        const failure = await probe("fixture-key", bad.baseUrl);
        expect(failure.ok).toBe(false);
        expect(failure.error).toContain("HTTP 401");
      } finally {
        ok.server.stop(true);
        bad.server.stop(true);
      }
    });
  }

  for (const provider of ["pi", "opencode"] as const) {
    for (const [env, url] of [
      [{ NAN_API_KEY: "fixture-nan" }, "https://api.nan.builders/v1/models"],
      [{ HELMCODE_API_NAN: "fixture-nan" }, "https://api.nan.builders/v1/models"],
      [{ HELMCODE_API_KEY: "fixture-helm" }, "https://api.helmcode.com/v1/models"],
      // `<ID>_BASE_URL` moves the probe with the provider.
      [
        { NAN_API_KEY: "fixture-nan", NAN_BASE_URL: "https://nan-gw.example.test/v1/" },
        "https://nan-gw.example.test/v1/models",
      ],
    ] as const) {
      test(`${provider}: ${Object.keys(env).join("+")} is probed at ${url}`, async () => {
        const realFetch = globalThis.fetch;
        const fetchMock = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
          return new Response("{}", { status: 200 });
        });
        globalThis.fetch = fetchMock as typeof fetch;
        try {
          const result = await validateProviderCredentials(provider, { ...env }, envReady);
          expect(result.ok).toBe(true);
          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(String(fetchMock.mock.calls[0]?.[0])).toBe(url);
          const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
          expect(headers.Authorization).toBe(`Bearer ${Object.values(env)[0]}`);
        } finally {
          globalThis.fetch = realFetch;
        }
      });
    }

    test(`${provider}: an OpenRouter key keeps the probe ahead of a NaN key`, async () => {
      const realFetch = globalThis.fetch;
      const fetchMock = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
        return new Response("{}", { status: 200 });
      });
      globalThis.fetch = fetchMock as typeof fetch;
      try {
        await validateProviderCredentials(
          provider,
          { OPENROUTER_API_KEY: "fixture-or", NAN_API_KEY: "fixture-nan" },
          envReady,
        );
        expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("nan.builders");
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }
});

// ─── Migration 055: report composition + opt-out ────────────────────────────

describe("isCredCheckDisabled", () => {
  test("true when CRED_CHECK_DISABLE is '1' or 'true' (case-insensitive)", () => {
    expect(isCredCheckDisabled({})).toBe(false);
    expect(isCredCheckDisabled({ CRED_CHECK_DISABLE: "0" })).toBe(false);
    expect(isCredCheckDisabled({ CRED_CHECK_DISABLE: "false" })).toBe(false);
    expect(isCredCheckDisabled({ CRED_CHECK_DISABLE: "true" })).toBe(true);
    expect(isCredCheckDisabled({ CRED_CHECK_DISABLE: "TRUE" })).toBe(true);
    expect(isCredCheckDisabled({ CRED_CHECK_DISABLE: "1" })).toBe(true);
  });
});

describe("buildCredStatusReport", () => {
  const HOME = "/home/worker";

  test("pi reports the opencode-go ids its pi-ai resolves", async () => {
    const snap = await buildCredStatusReport(
      "pi",
      { HOME },
      { homeDir: HOME, fs: fsWith(new Set([`${HOME}/.pi/agent/auth.json`])) },
      "boot",
    );
    expect(snap.opencodeGo?.models).toContain("deepseek-v4.1-flash");
    expect(snap.opencodeGo?.models).not.toContain("deepseek-v4-flash");
    const other = await buildCredStatusReport(
      "opencode",
      { HOME },
      { homeDir: HOME, fs: fsWith(new Set([`${HOME}/.local/share/opencode/auth.json`])) },
      "boot",
    );
    expect(other.opencodeGo).toBeNull();
  });

  for (const [provider, authPath] of [
    ["pi", ".pi/agent/auth.json"],
    ["opencode", ".local/share/opencode/auth.json"],
  ] as const) {
    test(`${provider}: auth.json gives a successful presence-only live test`, async () => {
      const realFetch = globalThis.fetch;
      const fetchMock = mock(async () => {
        throw new Error("file credentials must not be sent to a provider endpoint");
      });
      globalThis.fetch = fetchMock as typeof fetch;
      try {
        for (const env of [{ HOME }, { HOME, OPENROUTER_API_KEY: "unused-key" }]) {
          const snap = await buildCredStatusReport(
            provider,
            env,
            { homeDir: HOME, fs: fsWith(new Set([`${HOME}/${authPath}`])) },
            "boot",
          );
          expect(snap.ready).toBe(true);
          expect(snap.satisfiedBy).toBe("file");
          expect(snap.liveTest).toMatchObject({ ok: true, error: null, latency_ms: 0 });
        }
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    test(`${provider}: missing credentials do not become a successful live test`, async () => {
      const snap = await buildCredStatusReport(
        provider,
        {},
        { homeDir: HOME, fs: noFiles },
        "boot",
      );
      expect(snap.ready).toBe(false);
      expect(snap.liveTest).toBeNull();
    });

    for (const key of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const) {
      test(`${provider}: ${key} still receives a live probe and reports its result`, async () => {
        const realFetch = globalThis.fetch;
        let responseStatus = 200;
        const fetchMock = mock(async (_url: string | URL | Request, _init?: RequestInit) => {
          return new Response("{}", { status: responseStatus });
        });
        globalThis.fetch = fetchMock as typeof fetch;
        try {
          const env = { [key]: "provider-key" };
          const opts = { homeDir: HOME, fs: noFiles };
          const success = await buildCredStatusReport(provider, env, opts, "boot");
          expect(success.liveTest?.ok).toBe(true);
          responseStatus = 401;
          const failure = await buildCredStatusReport(provider, env, opts, "post_task");
          expect(failure.ready).toBe(true);
          expect(failure.liveTest?.ok).toBe(false);
          expect(failure.liveTest?.error).toContain("HTTP 401");
          expect(fetchMock).toHaveBeenCalledTimes(2);
          // OpenRouter's /models is public, so its key is checked on /key.
          expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
            key === "OPENROUTER_API_KEY" ? /\/key$/ : /\/models$/,
          );
        } finally {
          globalThis.fetch = realFetch;
        }
      });
    }
  }

  test("pi: a Google model with only GEMINI_API_KEY gives a successful presence-only live test", async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = mock(async () => {
      throw new Error("a presence-only credential must not issue a live probe");
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const snap = await buildCredStatusReport(
        "pi",
        { MODEL_OVERRIDE: "google/gemini-3-flash-preview", GEMINI_API_KEY: "google-key" },
        { homeDir: HOME, fs: noFiles },
        "boot",
      );
      expect(snap.ready).toBe(true);
      expect(snap.satisfiedBy).toBe("env");
      expect(snap.liveTest).toMatchObject({ ok: true, error: null, latency_ms: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

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

describe("OpenRouter and DeepSeek live checks", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Answers by path; records every URL. */
  function stubByPath(statusFor: (url: string) => number) {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return new Response("{}", { status: statusFor(url) });
    }) as typeof fetch;
    return urls;
  }

  test("OpenRouter checks the key on /key, not the public /models", async () => {
    const urls = stubByPath((url) => (url.endsWith("/key") ? 401 : 200));
    const result = await validateProviderCredentials("pi", { OPENROUTER_API_KEY: "or-bad" });
    expect(result).toMatchObject({ ok: false, httpStatus: 401 });
    expect(urls).toEqual(["https://openrouter.ai/api/v1/key"]);
  });

  test("a base URL without /key falls back to /models", async () => {
    const urls = stubByPath((url) => (url.endsWith("/key") ? 404 : 200));
    const result = await validateProviderCredentials("pi", { OPENROUTER_API_KEY: "or-key" });
    expect(result.ok).toBe(true);
    expect(urls).toEqual([
      "https://openrouter.ai/api/v1/key",
      "https://openrouter.ai/api/v1/models",
    ]);
  });

  test("dsh checks DEEPSEEK_API_KEY on DeepSeek /models, else OpenRouter", async () => {
    const urls = stubByPath(() => 401);
    const deepseek = await validateProviderCredentials("dsh", {
      DEEPSEEK_API_KEY: "ds-bad",
      OPENROUTER_API_KEY: "or-key",
    });
    expect(deepseek).toMatchObject({ ok: false, httpStatus: 401 });
    expect(urls).toEqual(["https://api.deepseek.com/models"]);

    const openrouter = await validateProviderCredentials("dsh", { OPENROUTER_API_KEY: "or-key" });
    expect(openrouter).toMatchObject({ ok: false, httpStatus: 401 });
    expect(urls.at(-1)).toBe("https://openrouter.ai/api/v1/key");
  });
});
