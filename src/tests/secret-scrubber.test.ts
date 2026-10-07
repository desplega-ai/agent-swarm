import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearVolatileSecretsForTesting,
  isSensitiveKey,
  refreshSecretScrubberCache,
  registerSensitiveKeyName,
  registerVolatileSecret,
  scrubObject,
  scrubSecrets,
} from "../utils/secret-scrubber";
import { randomToken } from "./synthetic-secret-helpers";

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
  test("redacts ACP session tokens in plain text and escaped session logs", () => {
    const token = `aseph_${"aB3".repeat(11)}`;
    const github = `ghp_${"gH4".repeat(12)}`;
    for (const prefix of ["Bearer ", "\\n", "\\t", '"']) {
      const input = `${prefix}${token} tail ${github}`;
      const output = scrubSecrets(input);
      expect(output).not.toContain(github);
      expect(output).toBe(`${prefix}[REDACTED:acp_session_token] tail [REDACTED:github_token]`);
      expect(scrubObject({ output: input })).toEqual({ output });
    }
  });

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
    process.env.FOO_SERVICE_API_KEY = "example-supersecretFooApiKey_longerthan12chars";
    refreshSecretScrubberCache();
    const out = scrubSecrets("key=example-supersecretFooApiKey_longerthan12chars tail");
    expect(out).toBe("key=[REDACTED:FOO_SERVICE_API_KEY] tail");
  });

  test("redacts any key with _TOKEN suffix", () => {
    process.env.WEIRD_SERVICE_TOKEN = "example-weirdserviceTOKENvalue_1234567890";
    refreshSecretScrubberCache();
    const out = scrubSecrets("t=example-weirdserviceTOKENvalue_1234567890");
    expect(out).toBe("t=[REDACTED:WEIRD_SERVICE_TOKEN]");
  });

  test("redacts any key with _SECRET suffix", () => {
    process.env.MY_OAUTH_CLIENT_SECRET = "example-oauthsecret_verylong_1234567890abcdef";
    refreshSecretScrubberCache();
    const out = scrubSecrets("secret=example-oauthsecret_verylong_1234567890abcdef");
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
      "example-ghp_poolfirst1234567890abcdefABCDEF1234567890," +
      "example-ghp_poolsecond1234567890abcdef1234567890AB";
    refreshSecretScrubberCache();
    const out = scrubSecrets("using example-ghp_poolfirst1234567890abcdefABCDEF1234567890");
    expect(out).not.toContain("example-ghp_poolfirst1234567890abcdefABCDEF1234567890");
    expect(out).toContain("[REDACTED:");
  });

  test("multi-secret line: both redacted", () => {
    process.env.GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    process.env.OPENAI_API_KEY = "sk-proj-abcd1234567890EFGHefgh1234567890";
    refreshSecretScrubberCache();
    const input =
      "gh=example-ghp_abcdefghijklmnopqrstuvwxyz0123456789 " +
      "and openai=example-sk-proj-abcd1234567890EFGHefgh1234567890";
    const out = scrubSecrets(input);
    expect(out).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(out).toContain("[REDACTED:OPENAI_API_KEY]");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("sk-proj-abcd1234567890");
  });

  test("redacts OTLP exporter headers from env", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "signoz-ingestion-key=localSignozKey_1234567890abcdef";
    refreshSecretScrubberCache();

    const out = scrubSecrets(
      "OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=localSignozKey_1234567890abcdef",
    );

    expect(out).toBe("OTEL_EXPORTER_OTLP_HEADERS=[REDACTED:OTEL_EXPORTER_OTLP_HEADERS]");
  });

  test("cache rebuilds after refresh when new secret is added", () => {
    const out1 = scrubSecrets("no secret yet here_abcdefghij");
    expect(out1).toBe("no secret yet here_abcdefghij");

    process.env.NEW_SERVICE_API_KEY = "example-here_abcdefghij_andmore1234567890";
    refreshSecretScrubberCache();
    const out2 = scrubSecrets("value=example-here_abcdefghij_andmore1234567890");
    expect(out2).toBe("value=[REDACTED:NEW_SERVICE_API_KEY]");
  });
});

describe("scrubSecrets — regex patterns", () => {
  test("redacts github_pat_ fine-grained PATs", () => {
    const token = `github_pat_${"a".repeat(32)}`;
    const out = scrubSecrets(`PAT: ${token}`);
    expect(out).toContain("[REDACTED:github_pat]");
    expect(out).not.toContain(token);
  });

  test("redacts ghp_ classic tokens", () => {
    const out = scrubSecrets("PAT: example-ghp_1234567890abcdefABCDEF1234567890ABCD end");
    expect(out).toContain("[REDACTED:github_token]");
    expect(out).not.toContain("ghp_1234567890abcdef");
  });

  test("redacts gho_ OAuth tokens", () => {
    const out = scrubSecrets("OAuth: example-gho_abcdef1234567890ABCDEF1234567890abcd");
    expect(out).toContain("[REDACTED:github_token]");
  });

  test("redacts ghs_ installation tokens", () => {
    const out = scrubSecrets("Installation: example-ghs_abcdef1234567890ABCDEF1234567890abcd");
    expect(out).toContain("[REDACTED:github_token]");
  });

  test("redacts glpat- GitLab PATs", () => {
    const out = scrubSecrets("GL: example-glpat-abcdef1234567890ABCDEFgh");
    expect(out).toContain("[REDACTED:gitlab_pat]");
    expect(out).not.toContain("glpat-abcdef");
  });

  test("redacts sk-ant- Anthropic keys", () => {
    const token = `sk-ant-${"a".repeat(32)}`;
    const out = scrubSecrets(`Anthropic: ${token}`);
    expect(out).toContain("[REDACTED:anthropic_key]");
    expect(out).not.toContain(token);
  });

  test("redacts sk-proj- OpenAI project keys (preferred over legacy sk-)", () => {
    const out = scrubSecrets("OpenAI: example-sk-proj-abcdefghijklmnopqrstuvwxyz012345");
    expect(out).toContain("[REDACTED:openai_proj_key]");
    expect(out).not.toContain("sk-proj-abcdefghijkl");
  });

  test("redacts legacy sk- keys (catch-all)", () => {
    const out = scrubSecrets("Legacy: example-sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(out).toContain("[REDACTED:sk_key]");
  });

  test("redacts Slack xoxb tokens", () => {
    const out = scrubSecrets("slack=example-xoxb-1234567890-0987654321-abcdefghij");
    expect(out).toContain("[REDACTED:slack_token]");
    expect(out).not.toContain("example-xoxb-1234567890");
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
    // `note=` is not a sensitive key, so only the token-shape pass can fire.
    const out = scrubSecrets(`note=example-${"ghp_"}1234567890abcdefABCDEF1234567890ABCD`);
    expect(out).toContain("[REDACTED:github_token]");
  });

  test("redacts SigNoz ingestion-key headers even when env is empty", () => {
    const out = scrubSecrets(
      "OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=localSignozKey_1234567890abcdef",
    );

    expect(out).toBe("OTEL_EXPORTER_OTLP_HEADERS=[REDACTED:signoz_ingestion_key]");
  });

  test("redacts Linear OAuth tokens", () => {
    const out = scrubSecrets("Authorization: Bearer example-lin_oauth_test123abcdef end");
    expect(out).toContain("[REDACTED:linear_oauth]");
    expect(out).not.toContain("lin_oauth_test123");
  });

  test("redacts Linear API keys", () => {
    const out = scrubSecrets("key=lin_api_test123abcdef tail");
    expect(out).toContain("[REDACTED:linear_api]");
    expect(out).not.toContain("lin_api_test123");
  });

  test("redacts npm tokens", () => {
    const out = scrubSecrets("npm=npm_abcdefghijklmnopqrstuvwxyz01234");
    expect(out).toContain("[REDACTED:npm_token]");
    expect(out).not.toContain("npm_abcdefghijklmnopqr");
  });

  test("redacts Atlassian/Jira API tokens", () => {
    const out = scrubSecrets("jira=ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("[REDACTED:atlassian_token]");
    expect(out).not.toContain("ATATT3xFfGF0");
  });

  test("redacts tokens adjacent to JSON escape sequences (\\n)", () => {
    const content = "data\\nlin_oauth_test123abcdef\\nmore";
    const out = scrubSecrets(content);
    expect(out).toContain("[REDACTED:linear_oauth]");
    expect(out).not.toContain("lin_oauth_test123");
  });

  test("redacts tokens adjacent to JSON escape sequences (\\t, \\r)", () => {
    const outT = scrubSecrets("field\\tlin_oauth_test123abcdef");
    expect(outT).toContain("[REDACTED:linear_oauth]");
    const outR = scrubSecrets("line\\rlin_oauth_test123abcdef");
    expect(outR).toContain("[REDACTED:linear_oauth]");
  });

  test("redacts tokens in double-encoded JSON with escape sequences", () => {
    const inner = JSON.stringify({
      access_token: "example-lin_oauth_test123abcdef",
      scope: "read",
    });
    const content = `{"output":${JSON.stringify(inner)}}`;
    const out = scrubSecrets(content);
    expect(out).toContain("[REDACTED:linear_oauth]");
    expect(out).not.toContain("lin_oauth_test123");
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

describe("scrubObject", () => {
  test("scrubs nested object and array string leaves", () => {
    process.env.NESTED_TOKEN = "example-nested-secret-value-1234567890";
    refreshSecretScrubberCache();

    const out = scrubObject({
      keep: 1,
      nested: {
        secret: "example-nested-secret-value-1234567890",
        list: ["safe", "example-nested-secret-value-1234567890"],
      },
      nullish: null,
      bool: true,
    });

    expect(out).toEqual({
      keep: 1,
      nested: {
        secret: "[REDACTED:NESTED_TOKEN]",
        list: ["safe", "[REDACTED:NESTED_TOKEN]"],
      },
      nullish: null,
      bool: true,
    });
  });

  test("handles circular references without recursing forever", () => {
    const value: Record<string, unknown> = { a: "ok" };
    value.self = value;

    expect(scrubObject(value)).toEqual({ a: "ok", self: "[Circular]" });
  });
});

describe("registerVolatileSecret", () => {
  afterEach(() => {
    clearVolatileSecretsForTesting();
  });

  test("scrubs a runtime-registered volatile secret", () => {
    const secret = "example-volatile_runtime_token_1234567890abcdef";
    registerVolatileSecret(secret, "RUNTIME_TOKEN");
    const out = scrubSecrets(`key=${secret}`);
    expect(out).toBe("key=[REDACTED:RUNTIME_TOKEN]");
    expect(out).not.toContain(secret);
  });

  test("ignores values shorter than the minimum length", () => {
    registerVolatileSecret("short", "TOO_SHORT");
    const out = scrubSecrets("contains short somewhere");
    expect(out).toBe("contains short somewhere");
  });
});

// All values below are synthetic. `declare -x` (and bash `export -p`) wraps a
// value in double quotes and prefixes `\`, `$`, `"` and backtick with `\`.
function declareX(key: string, value: string): string {
  return `declare -x ${key}="${value.replace(/[\\$"`]/g, "\\$&")}"`;
}

/** A log line as it lands in session_logs: the text inside a JSON string. */
function jsonBody(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

describe("scrubSecrets — env dumps and escaped forms", () => {
  afterEach(() => {
    clearVolatileSecretsForTesting();
  });

  test("redacts an 8-char secret in a sensitive assignment, raw and JSON-escaped", () => {
    const secret = "Qz8#kLm2";
    process.env.DEMO_ACCOUNT_PASSWORD = secret;
    refreshSecretScrubberCache();

    const dump = declareX("DEMO_ACCOUNT_PASSWORD", secret);
    expect(scrubSecrets(dump)).toBe(
      'declare -x DEMO_ACCOUNT_PASSWORD="[REDACTED:DEMO_ACCOUNT_PASSWORD]"',
    );
    expect(scrubSecrets(jsonBody(dump))).toBe(
      'declare -x DEMO_ACCOUNT_PASSWORD=\\"[REDACTED:DEMO_ACCOUNT_PASSWORD]\\"',
    );
    expect(scrubSecrets(`DEMO_ACCOUNT_PASSWORD=${secret}\\nNEXT=1`)).toBe(
      "DEMO_ACCOUNT_PASSWORD=[REDACTED:DEMO_ACCOUNT_PASSWORD]\\nNEXT=1",
    );
    expect(scrubSecrets(`export DEMO_ACCOUNT_PASSWORD='${secret}'`)).toBe(
      "export DEMO_ACCOUNT_PASSWORD='[REDACTED:DEMO_ACCOUNT_PASSWORD]'",
    );
  });

  test("redacts a short secret whose key is only known as an isSecret config row", () => {
    const secret = "pw7$Kx";
    const dump = jsonBody(`${declareX("DEMO_LOGIN_PW", secret)}\n`);
    // Not sensitive by name alone.
    expect(scrubSecrets(dump)).toBe(dump);

    registerSensitiveKeyName("DEMO_LOGIN_PW");
    const out = scrubSecrets(dump);
    expect(out).toBe('declare -x DEMO_LOGIN_PW=\\"[REDACTED:DEMO_LOGIN_PW]\\"\\n');
    expect(out).not.toContain("Kx");
  });

  test('redacts a secret containing $ and " rendered through declare -x', () => {
    const secret = 'Ab$cD"eF`gh\\iJ90';
    process.env.DEMO_BOT_PASS = secret;
    refreshSecretScrubberCache();

    const dump = declareX("DEMO_BOT_PASS", secret);
    for (const line of [dump, jsonBody(dump)]) {
      const out = scrubSecrets(line);
      expect(out).toContain("[REDACTED:DEMO_BOT_PASS]");
      expect(out).not.toContain("iJ90");
    }

    // Outside an assignment, the exact-match pass still sees the escaped forms.
    const escaped = secret.replace(/[\\$"`]/g, "\\$&");
    for (const line of [`echo "${escaped}"`, jsonBody(`echo "${escaped}"`), jsonBody(secret)]) {
      const out = scrubSecrets(line);
      expect(out).toContain("[REDACTED:DEMO_BOT_PASS]");
      expect(out).not.toContain("iJ90");
    }
  });

  test("redacts a harness-generated *_TOKEN value this process never saw", () => {
    const token = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    // The harness sets this in its child's env, not in the scrubbing process.
    delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    refreshSecretScrubberCache();
    const dump = declareX("CLAUDE_CODE_MESSAGING_TOKEN", token);
    expect(scrubSecrets(dump)).toBe(
      'declare -x CLAUDE_CODE_MESSAGING_TOKEN="[REDACTED:CLAUDE_CODE_MESSAGING_TOKEN]"',
    );
    expect(scrubSecrets(jsonBody(`x\n${dump}\n`))).toBe(
      'x\\ndeclare -x CLAUDE_CODE_MESSAGING_TOKEN=\\"[REDACTED:CLAUDE_CODE_MESSAGING_TOKEN]\\"\\n',
    );
  });

  test("registered volatile secrets are matched in escaped forms too", () => {
    const secret = 'vol$tile"Secret_123';
    registerVolatileSecret(secret, "config:DEMO_VOLATILE");
    const out = scrubSecrets(jsonBody(`a ${secret} b ${secret.replace(/[\\$"`]/g, "\\$&")}`));
    expect(out).toBe("a [REDACTED:config:DEMO_VOLATILE] b [REDACTED:config:DEMO_VOLATILE]");
  });

  test("leaves short non-secret values and non-assignments alone", () => {
    process.env.DEMO_SHORT_TOKEN = "deploy";
    refreshSecretScrubberCache();
    const s = [
      declareX("USER", "deploy"),
      declareX("SHELL", "/bin/bash"),
      "NODE_ENV=prod LANG=C",
      "logged in as deploy",
      "if (process.env.GITHUB_TOKEN === undefined) return;",
      "DEMO_SHORT_TOKEN== deploy",
      'declare -x DEMO_SHORT_TOKEN=""',
    ].join("\n");
    expect(scrubSecrets(s)).toBe(s);
    expect(scrubSecrets(jsonBody(s))).toBe(jsonBody(s));
  });

  test("leaves shell references under a sensitive key intact", () => {
    const s = [
      "export GH_TOKEN=$(gh auth token) && gh pr list",
      "ATTIO_API_KEY=$(get-config ATTIO_API_KEY)",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing shell syntax
      "FOO_TOKEN=${OTHER_TOKEN} run",
      'FOO_TOKEN="$OTHER_TOKEN" run',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing shell syntax
      'FOO_TOKEN="${OTHER_TOKEN:-x}" run',
    ].join("\n");
    expect(scrubSecrets(s)).toBe(s);
    expect(scrubSecrets(jsonBody(s))).toBe(jsonBody(s));

    // An assignment nested inside the reference is still scanned.
    expect(scrubSecrets("A_TOKEN=$(B_TOKEN=s3cr3t cmd)")).toBe(
      "A_TOKEN=$(B_TOKEN=[REDACTED:B_TOKEN] cmd)",
    );
    // Single quotes are literal in shell, and declare -x escapes a literal `$`.
    expect(scrubSecrets("FOO_TOKEN='$lit3ral' run")).toBe("FOO_TOKEN='[REDACTED:FOO_TOKEN]' run");
    const dump = declareX("FOO_TOKEN", "$lit3ral");
    expect(scrubSecrets(dump)).toBe('declare -x FOO_TOKEN="[REDACTED:FOO_TOKEN]"');
    expect(scrubSecrets(jsonBody(dump))).toBe('declare -x FOO_TOKEN=\\"[REDACTED:FOO_TOKEN]\\"');
  });

  test("an unterminated quoted value stops at the first newline", () => {
    for (const s of [
      'Set API_TOKEN="\nline two\nline "three" here',
      "Set API_TOKEN='\nline two\nline 'three' here",
    ]) {
      expect(scrubSecrets(s)).toBe(s);
      expect(scrubSecrets(jsonBody(s))).toBe(jsonBody(s));
    }

    const s = 'Set API_TOKEN="abc123\nline two\nline "three" here';
    const want = 'Set API_TOKEN="[REDACTED:API_TOKEN]\nline two\nline "three" here';
    expect(scrubSecrets(s)).toBe(want);
    expect(scrubSecrets(jsonBody(s))).toBe(jsonBody(want));
  });

  test("a quoted value closed at end of line may span lines", () => {
    const dump = `${declareX("DEMO_MULTI_TOKEN", "line1\nline2")}\n${declareX("USER", "deploy")}`;
    const want = `declare -x DEMO_MULTI_TOKEN="[REDACTED:DEMO_MULTI_TOKEN]"\n${declareX("USER", "deploy")}`;
    expect(scrubSecrets(dump)).toBe(want);
    expect(scrubSecrets(jsonBody(dump))).toBe(jsonBody(want));
  });

  test("is idempotent on redacted assignments", () => {
    process.env.DEMO_ACCOUNT_PASSWORD = "Qz8#kLm2";
    refreshSecretScrubberCache();
    for (const line of [
      declareX("DEMO_ACCOUNT_PASSWORD", "Qz8#kLm2"),
      jsonBody(declareX("DEMO_ACCOUNT_PASSWORD", "Qz8#kLm2")),
      "DEMO_ACCOUNT_PASSWORD=Qz8#kLm2",
    ]) {
      const once = scrubSecrets(line);
      expect(scrubSecrets(once)).toBe(once);
    }
  });
});

// Every credential below is built at runtime; nothing secret-shaped is a literal.
function pemBlock(label: string): string {
  const body = Array.from({ length: 5 }, () => randomToken(64)).join("\n");
  return `-----BEGIN ${label}PRIVATE KEY-----\n${body}\n-----END ${label}PRIVATE KEY-----`;
}

interface ProbeCase {
  shape: string;
  input: string;
  want: string;
  secret: string;
}

function probeCases(): ProbeCase[] {
  const cases: ProbeCase[] = [];
  const add = (shape: string, secret: string, input: string, want: string) =>
    cases.push({ shape, input, want, secret });
  let s = randomToken(24);
  add("bare PRIVATE_KEY=", s, `PRIVATE_KEY=${s}`, "PRIVATE_KEY=[REDACTED:PRIVATE_KEY]");
  s = randomToken(24);
  add("bare SECRET=", s, `SECRET=${s} next`, "SECRET=[REDACTED:SECRET] next");
  s = randomToken(10);
  add("bare PASSWORD=", s, `PASSWORD='${s}'`, "PASSWORD='[REDACTED:PASSWORD]'");
  s = randomToken(32);
  add("lowercase api_key=", s, `api_key=${s}`, "api_key=[REDACTED:api_key]");
  s = randomToken(32);
  add(
    "dotted SLACK.BOT.TOKEN=",
    s,
    `SLACK.BOT.TOKEN=${s}`,
    "SLACK.BOT.TOKEN=[REDACTED:SLACK.BOT.TOKEN]",
  );
  s = randomToken(40);
  add(
    "AWS_SECRET_ACCESS_KEY=",
    s,
    `export AWS_SECRET_ACCESS_KEY=${s}`,
    "export AWS_SECRET_ACCESS_KEY=[REDACTED:AWS_SECRET_ACCESS_KEY]",
  );
  s = randomToken(40);
  add(
    "INI aws_secret_access_key = …",
    s,
    `[default]\naws_secret_access_key = ${s}\nregion = us-east-1`,
    "[default]\naws_secret_access_key = [REDACTED:aws_secret_access_key]\nregion = us-east-1",
  );
  s = randomToken(20);
  add(
    "DATABASE_URL with userinfo",
    s,
    `DATABASE_URL=postgres://app:${s}@db.example:5432/x`,
    "DATABASE_URL=postgres://app:[REDACTED:url_password]@db.example:5432/x",
  );
  s = randomToken(20);
  add(
    "https URL with userinfo",
    s,
    `git clone https://bob:${s}@git.example/r.git`,
    "git clone https://bob:[REDACTED:url_password]@git.example/r.git",
  );
  for (const label of ["RSA ", "OPENSSH "]) {
    const pem = pemBlock(label);
    add(
      `${label}PEM block`,
      pem.split("\n")[2] ?? "",
      `key:\n${pem}\ndone`,
      `key:\n-----BEGIN ${label}PRIVATE KEY-----[REDACTED:private_key]-----END ${label}PRIVATE KEY-----\ndone`,
    );
  }
  const gcpPem = pemBlock("");
  add(
    "GCP service-account JSON private_key",
    gcpPem.split("\n")[2] ?? "",
    JSON.stringify({
      type: "service_account",
      private_key: `${gcpPem}\n`,
      client_email: "bot@x.example",
    }),
    '{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----[REDACTED:private_key]-----END PRIVATE KEY-----\\n","client_email":"bot@x.example"}',
  );
  s = `${randomToken(30)}.${randomToken(20)}`;
  add(
    "Authorization: Bearer (raw)",
    s,
    `Authorization: Bearer ${s}\nAccept: */*`,
    "Authorization: Bearer [REDACTED:authorization]\nAccept: */*",
  );
  s = randomToken(40);
  add(
    "Authorization: Bearer (JSON headers)",
    s,
    JSON.stringify({ headers: { Authorization: `Bearer ${s}`, Accept: "x" } }),
    '{"headers":{"Authorization":"Bearer [REDACTED:authorization]","Accept":"x"}}',
  );
  s = randomToken(32);
  add("x-api-key header", s, `x-api-key: ${s}`, "x-api-key: [REDACTED:x_api_key]");
  s = randomToken(40);
  add(
    "curl -H 'Authorization: token …'",
    s,
    `curl -H 'Authorization: token ${s}' https://api.example/x`,
    "curl -H 'Authorization: token [REDACTED:authorization]' https://api.example/x",
  );
  s = randomToken(14);
  add(
    "curl --password",
    s,
    `curl --user bob --password ${s} https://x.example`,
    "curl --user bob --password [REDACTED:curl_password] https://x.example",
  );
  s = randomToken(14);
  add(
    "curl -u user:pass",
    s,
    `curl -u bob:${s} https://x.example`,
    "curl -u bob:[REDACTED:curl_password] https://x.example",
  );
  s = `${randomToken(8)}\\"${randomToken(8)}`;
  add(
    'JSON "password" (with an escaped quote)',
    s,
    `{"user":"bob","password":"${s}"}`,
    '{"user":"bob","password":"[REDACTED:password]"}',
  );
  s = randomToken(32);
  add('JSON "apiKey"', s, JSON.stringify({ apiKey: s }), '{"apiKey":"[REDACTED:apiKey]"}');
  s = randomToken(32);
  add(
    'JSON "client_secret"',
    s,
    JSON.stringify({ client_id: "abc", client_secret: s }),
    '{"client_id":"abc","client_secret":"[REDACTED:client_secret]"}',
  );
  s = randomToken(32);
  add(
    "YAML token:",
    s,
    `auth:\n  token: ${s}\n  user: bob\n`,
    "auth:\n  token: [REDACTED:token]\n  user: bob\n",
  );
  return cases;
}

describe("scrubSecrets — structured credentials (audit probe)", () => {
  for (const { shape, input, want, secret } of probeCases()) {
    test(shape, () => {
      expect(secret.length).toBeGreaterThan(8);
      // Raw, and JSON-escaped as the line lands in session_logs.
      for (const [text, expected] of [
        [input, want],
        [jsonBody(input), jsonBody(want)],
      ]) {
        const out = scrubSecrets(text);
        expect(out).not.toContain(secret);
        expect(out).toContain("[REDACTED:");
        expect(out).toBe(expected as string);
        expect(scrubSecrets(out)).toBe(out);
      }
    });
  }

  test("a JSON private_key value is consumed whole across \\n escapes", () => {
    const tail = randomToken(24);
    const input = JSON.stringify({ private_key: `${randomToken(16)}\n${tail}\n` });
    expect(scrubSecrets(input)).toBe('{"private_key":"[REDACTED:private_key]"}');
  });

  test("a sensitive key nested under a dotted path still counts", () => {
    const s = randomToken(20);
    expect(scrubSecrets(`config.SECRETS_ENCRYPTION_KEY=${s}`)).toBe(
      "config.SECRETS_ENCRYPTION_KEY=[REDACTED:config.SECRETS_ENCRYPTION_KEY]",
    );
  });

  test("isSensitiveKey normalizes case, camelCase, dots and dashes", () => {
    for (const key of [
      "apiKey",
      "client_secret",
      "x-api-key",
      "slack.bot.token",
      "secretAccessKey",
      "SENTRY_DSN",
      "DEPLOY_CREDENTIALS",
      "passwd",
    ]) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of [
      "PWD",
      "SORT_KEY",
      "primaryKey",
      "contextKey",
      "max_tokens",
      "token_count",
      "nextPageToken",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "MCP_BASE_URL",
    ]) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe("scrubSecrets — over-redaction guards", () => {
  test("non-secret text stays byte-identical, raw and JSON-escaped", () => {
    const sha = randomToken(40)
      .toLowerCase()
      .replace(/[^0-9a-f]/g, "0");
    const png = `data:image/png;base64,${Buffer.from(randomToken(60)).toString("base64")}`;
    const lines = [
      "max_tokens=4096",
      '"input_tokens": 1234',
      "token_count: 12",
      "PWD=/workspace",
      "SORT_KEY=abc",
      "primaryKey: id",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing workflow syntax
      "password: ${{ secrets.DB_PASSWORD }}",
      "token: <your-token>",
      "Authorization: Bearer [REDACTED:x]",
      `commit ${sha}`,
      crypto.randomUUID(),
      `task: ${crypto.randomUUID()}`,
      png,
      "https://github.com/org/repo",
      "const password = getPassword()",
      // Code and prose that share a key name with a credential.
      "  token: string;",
      "  password: process.env.DB_PASSWORD",
      "token = get_token()",
      "    password = pwd",
      "Authorization: Bearer followed by the token",
      '{"nextPageToken":"CAoQAA","secret":false,"token":null}',
      "docker run -u 1000:1000 -u node:node img",
      "echo $PW | docker login --password-stdin",
      "http://localhost:3013/x?email=a@b.example",
      "GOOGLE_APPLICATION_CREDENTIALS=/home/worker/.config/gcloud/sa.json",
      "      - uses: actions/checkout@v4",
      "postgres://app:***@db.example/x",
    ];
    for (const line of lines) {
      expect(scrubSecrets(line)).toBe(line);
      expect(scrubSecrets(jsonBody(line))).toBe(jsonBody(line));
    }
    const all = lines.join("\n");
    expect(scrubSecrets(all)).toBe(all);
    expect(scrubSecrets(jsonBody(all))).toBe(jsonBody(all));
  });

  // Each input is ~200 KB and built to make a naive pattern backtrack.
  // retry: wall-clock bound on a shared CI runner; a real ReDoS takes seconds.
  test(
    "new key-context rules stay linear on 200 KB adversarial input",
    () => {
      const inputs = [
        `-----BEGIN RSA PRIVATE KEY-----${"A".repeat(200_000)}`,
        "-----BEGIN RSA PRIVATE KEY-----\n".repeat(6_000),
        `"password": "${"\\\\".repeat(100_000)}`,
        `\\"password\\": \\"${"\\\\".repeat(100_000)}`,
        `"password": "${"a".repeat(200_000)}`,
        `\\"password\\": \\"${"a".repeat(200_000)}`,
        `"password": "`.repeat(14_000),
        `token: ${"a".repeat(200_000)} x`,
        "token: a\n".repeat(25_000),
        `password = ${"a".repeat(200_000)} x`,
        "Authorization: Bearer ".repeat(9_000),
        `Authorization: Bearer ${"A".repeat(200_000)}[`,
        "a".repeat(200_000),
        `https://${"u".repeat(200_000)}`,
        "a://a:".repeat(33_000),
        " -u a:".repeat(33_000),
        `curl -u ${"a".repeat(200_000)}`,
        "a.".repeat(100_000),
        "\\n".repeat(100_000),
        `"${"a".repeat(63)}":`.repeat(3_000),
      ];
      for (const input of inputs) {
        const start = performance.now();
        scrubSecrets(input);
        expect(performance.now() - start).toBeLessThan(50);
      }
    },
    { retry: 2 },
  );
});
