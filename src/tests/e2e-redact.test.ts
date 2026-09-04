import { describe, expect, test } from "bun:test";
import { knownSecrets, redactSecrets } from "../../scripts/e2e/redact";

describe("e2e redaction", () => {
  test("masks exact known values and common token shapes", () => {
    const text = [
      "Authorization: Bearer 0123456789abcdef0123456789abcdef",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123",
      "anthropic sk-ant-api03-abcdefghijklmnop",
      "github ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "slack xoxb-1234567890-abcdefghijk",
      'auth.json {"refresh_token":"rt-abcdefghijklmnop","id_token":"x.y.z"}',
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      "my-secret-run-key-value appears here",
    ].join("\n");
    const out = redactSecrets(text, ["my-secret-run-key-value"]);
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
    expect(out).not.toContain("sk-proj-");
    expect(out).not.toContain("sk-ant-");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("xoxb-");
    expect(out).not.toContain("rt-abcdefghijklmnop");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).not.toContain("my-secret-run-key-value");
    expect(out).toContain("Authorization: Bearer [REDACTED]");
    expect(out).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(out).toContain("[REDACTED] appears here");
  });

  test("leaves ordinary worker log lines alone", () => {
    const text = [
      "[worker] Trigger received: task_assigned",
      "[worker] Loaded 47 skills for system prompt",
      "INFO harness claude cost records: 1 ($0.1513, pricing-table)",
      "inputTokens: 217652, outputTokens: 1609",
      "[credentials] Selected OPENROUTER_API_KEY credential 1/1 (1 available of 1) [...daec4]",
      "createSession failed: EACCES: permission denied, open '/__w/agent-swarm/AGENTS.md'",
    ].join("\n");
    expect(redactSecrets(text, ["short"])).toBe(text);
  });

  test("knownSecrets reads provider env values and the codex blob fields", () => {
    const saved = { ...process.env };
    try {
      process.env.OPENROUTER_API_KEY = "sk-or-v1-known-value-1234";
      process.env.CODEX_OAUTH = JSON.stringify({
        access: "access-token-value-1234",
        refresh: "refresh-token-value-1234",
        expires: 1,
        accountId: "acct",
      });
      const known = knownSecrets(["extra-secret-value"]);
      expect(known).toContain("sk-or-v1-known-value-1234");
      expect(known).toContain("access-token-value-1234");
      expect(known).toContain("refresh-token-value-1234");
      expect(known).toContain("extra-secret-value");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });
});
