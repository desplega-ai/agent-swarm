import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { refreshSecretScrubberCache, scrubSecrets } from "../utils/secret-scrubber";

// Snapshot/restore process.env between tests so env-derived cache entries
// don't leak across cases.
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = { ...process.env };
  refreshSecretScrubberCache();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  refreshSecretScrubberCache();
});

describe("scrubSecrets — edge cases", () => {
  test("empty string passes through", () => {
    expect(scrubSecrets("")).toBe("");
  });

  test("null returns empty string", () => {
    expect(scrubSecrets(null)).toBe("");
  });

  test("undefined returns empty string", () => {
    expect(scrubSecrets(undefined)).toBe("");
  });

  test("plain text with no secrets passes through untouched", () => {
    const s = "hello world, this is a regular log line with no secrets";
    expect(scrubSecrets(s)).toBe(s);
  });
});

describe("scrubSecrets — env-based replacement", () => {
  test("redacts exact GITHUB_TOKEN value from env", () => {
    process.env.GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    refreshSecretScrubberCache();
    const out = scrubSecrets("Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789 end");
    expect(out).toBe("Authorization: Bearer [REDACTED:GITHUB_TOKEN] end");
  });

  test("redacts any key with _API_KEY suffix", () => {
    process.env.FOO_SERVICE_API_KEY = "supersecretFooApiKey_longerthan12chars";
    refreshSecretScrubberCache();
    const out = scrubSecrets("key=supersecretFooApiKey_longerthan12chars tail");
    expect(out).toBe("key=[REDACTED:FOO_SERVICE_API_KEY] tail");
  });

  test("redacts any key with _TOKEN suffix", () => {
    process.env.WEIRD_SERVICE_TOKEN = "weirdserviceTOKENvalue_1234567890";
    refreshSecretScrubberCache();
    const out = scrubSecrets("t=weirdserviceTOKENvalue_1234567890");
    expect(out).toBe("t=[REDACTED:WEIRD_SERVICE_TOKEN]");
  });

  test("redacts any key with _SECRET suffix", () => {
    process.env.MY_OAUTH_CLIENT_SECRET = "oauthsecret_verylong_1234567890abcdef";
    refreshSecretScrubberCache();
    const out = scrubSecrets("secret=oauthsecret_verylong_1234567890abcdef");
    expect(out).toBe("secret=[REDACTED:MY_OAUTH_CLIENT_SECRET]");
  });

  test("does not redact safe keys like MCP_BASE_URL even though they could otherwise match suffix heuristics", () => {
    // MCP_BASE_URL is on the exception allowlist — must not get scrubbed.
    process.env.MCP_BASE_URL = "https://api.swarm.example.com:3013";
    refreshSecretScrubberCache();
    const out = scrubSecrets("connecting to https://api.swarm.example.com:3013");
    expect(out).toBe("connecting to https://api.swarm.example.com:3013");
  });

  test("does not redact values shorter than the minimum length (defense against false positives)", () => {
    process.env.SHORT_TOKEN = "abc12"; // 5 chars, below threshold
    refreshSecretScrubberCache();
    const out = scrubSecrets("contains abc12 somewhere");
    expect(out).toBe("contains abc12 somewhere");
  });

  test("does not redact non-sensitive env vars", () => {
    process.env.NODE_ENV = "production";
    refreshSecretScrubberCache();
    const out = scrubSecrets("env is production currently");
    expect(out).toBe("env is production currently");
  });

  test("handles comma-separated pool values (scrubs both the full pool and each component)", () => {
    process.env.POOL_TOKEN =
      "ghp_poolfirst1234567890abcdefABCDEF1234567890,ghp_poolsecond1234567890abcdef1234567890AB";
    refreshSecretScrubberCache();
    const out = scrubSecrets("using ghp_poolfirst1234567890abcdefABCDEF1234567890");
    expect(out).not.toContain("ghp_poolfirst1234567890abcdefABCDEF1234567890");
    expect(out).toContain("[REDACTED:");
  });

  test("multi-secret line: both redacted", () => {
    process.env.GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    process.env.OPENAI_API_KEY = "sk-proj-abcd1234567890EFGHefgh1234567890";
    refreshSecretScrubberCache();
    const input =
      "gh=ghp_abcdefghijklmnopqrstuvwxyz0123456789 and openai=sk-proj-abcd1234567890EFGHefgh1234567890";
    const out = scrubSecrets(input);
    expect(out).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(out).toContain("[REDACTED:OPENAI_API_KEY]");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("sk-proj-abcd1234567890");
  });

  test("cache rebuilds after refresh when new secret is added", () => {
    const out1 = scrubSecrets("no secret yet here_abcdefghij");
    expect(out1).toBe("no secret yet here_abcdefghij");

    process.env.NEW_SERVICE_API_KEY = "here_abcdefghij_andmore1234567890";
    refreshSecretScrubberCache();
    const out2 = scrubSecrets("value=here_abcdefghij_andmore1234567890");
    expect(out2).toBe("value=[REDACTED:NEW_SERVICE_API_KEY]");
  });
});

describe("scrubSecrets — regex patterns", () => {
  test("redacts github_pat_ fine-grained PATs", () => {
    const out = scrubSecrets("PAT: github_pat_11B4WKYAA0Qe95fajGmt3o_ABCDEF1234567890abcdef");
    expect(out).toContain("[REDACTED:github_pat]");
    expect(out).not.toContain("github_pat_11B4WKYAA");
  });

  test("redacts ghp_ classic tokens", () => {
    const out = scrubSecrets("PAT: ghp_1234567890abcdefABCDEF1234567890ABCD end");
    expect(out).toContain("[REDACTED:github_token]");
    expect(out).not.toContain("ghp_1234567890abcdef");
  });

  test("redacts gho_ OAuth tokens", () => {
    const out = scrubSecrets("OAuth: gho_abcdef1234567890ABCDEF1234567890abcd");
    expect(out).toContain("[REDACTED:github_token]");
  });

  test("redacts ghs_ installation tokens", () => {
    const out = scrubSecrets("Installation: ghs_abcdef1234567890ABCDEF1234567890abcd");
    expect(out).toContain("[REDACTED:github_token]");
  });

  test("redacts glpat- GitLab PATs", () => {
    const out = scrubSecrets("GL: glpat-abcdef1234567890ABCDEFgh");
    expect(out).toContain("[REDACTED:gitlab_pat]");
    expect(out).not.toContain("glpat-abcdef");
  });

  test("redacts sk-ant- Anthropic keys", () => {
    const out = scrubSecrets("Anthropic: sk-ant-api03-abc123def456ghi789jkl012mno345");
    expect(out).toContain("[REDACTED:anthropic_key]");
    expect(out).not.toContain("sk-ant-api03");
  });

  test("redacts sk-proj- OpenAI project keys (preferred over legacy sk-)", () => {
    const out = scrubSecrets("OpenAI: sk-proj-abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("[REDACTED:openai_proj_key]");
    expect(out).not.toContain("sk-proj-abcdefghijkl");
  });

  test("redacts legacy sk- keys (catch-all)", () => {
    const out = scrubSecrets("Legacy: sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(out).toContain("[REDACTED:sk_key]");
  });

  test("redacts Slack xoxb tokens", () => {
    const out = scrubSecrets("slack=xoxb-1234567890-0987654321-abcdefghij");
    expect(out).toContain("[REDACTED:slack_token]");
    expect(out).not.toContain("xoxb-1234567890");
  });

  test("redacts AWS access key IDs", () => {
    const out = scrubSecrets("AWS: AKIAIOSFODNN7EXAMPLE in config");
    expect(out).toContain("[REDACTED:aws_access_key]");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("redacts Google AIza API keys", () => {
    // Google API key shape: `AIza` + exactly 35 word chars.
    const out = scrubSecrets("gapi: AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 tail");
    expect(out).toContain("[REDACTED:google_api_key]");
    expect(out).not.toContain("AIzaSyABCDEFGHI");
  });

  test("redacts JWT-shaped tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = scrubSecrets(`auth: ${jwt}`);
    expect(out).toContain("[REDACTED:jwt]");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  test("regex patterns catch tokens even when env is empty", () => {
    // Fresh env — no secrets registered — regex should still catch well-known shapes.
    const out = scrubSecrets("token=ghp_1234567890abcdefABCDEF1234567890ABCD");
    expect(out).toContain("[REDACTED:github_token]");
  });
});

describe("scrubSecrets — does not over-scrub", () => {
  test("the word 'token' in prose is not redacted", () => {
    const s = "Please provide your access token in the Authorization header.";
    expect(scrubSecrets(s)).toBe(s);
  });

  test("short strings are never redacted by regex", () => {
    const out = scrubSecrets("gh pr ghp_short or ghp_ghp_ or ghp_abc");
    // "ghp_abc" is only 7 chars — below the 20-char threshold.
    expect(out).toBe("gh pr ghp_short or ghp_ghp_ or ghp_abc");
  });

  test("arbitrary base64 strings that don't match any credential shape are preserved", () => {
    const b64 = "SGVsbG8gV29ybGQhIFRoaXMgaXMgbm90IGEgc2VjcmV0Lg==";
    const out = scrubSecrets(`data: ${b64}`);
    expect(out).toContain(b64);
  });

  test("idempotent — scrubbing an already-scrubbed string is a no-op", () => {
    process.env.GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    refreshSecretScrubberCache();
    const once = scrubSecrets("x=ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    const twice = scrubSecrets(once);
    expect(twice).toBe(once);
    expect(twice).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  test("the `[REDACTED:...]` markers themselves don't get scrubbed", () => {
    // Important: the marker strings include `_` so we need to ensure the regex
    // patterns don't chew through `[REDACTED:github_pat]` etc.
    const out = scrubSecrets("result=[REDACTED:github_token] OK");
    expect(out).toBe("result=[REDACTED:github_token] OK");
  });

  test("preserves placeholder-style fake tokens in docs without env registration", () => {
    // "ghp_YOUR_TOKEN_HERE" matches the regex because it has 17 chars after
    // ghp_ which is > 20 total — but we'd rather scrub than leak, so accept
    // this as expected (no test assertion that it's preserved).
    // Instead, assert a shorter placeholder is NOT scrubbed.
    const out = scrubSecrets("example: ghp_TOKEN and glpat-xyz (both too short)");
    expect(out).toBe("example: ghp_TOKEN and glpat-xyz (both too short)");
  });
});
