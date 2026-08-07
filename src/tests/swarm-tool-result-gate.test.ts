import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getKv, initDb } from "../be/db";
import { SCRIPT_LONG_TIMEOUT_HINT_MS } from "../scripts-runtime/executors/types";
import { createServer } from "../server";
import {
  finalizeSwarmToolResult,
  findLongScriptTimeoutHint,
  MCP_OVERFLOW_TTL_MS,
  MCP_RESULT_WIRE_LIMIT_BYTES,
  mcpOverflowNamespace,
  SCRIPT_AUTHORING_NUDGE,
  SCRIPT_RUN_TIMEOUT_NUDGE,
  type SwarmToolResult,
  type SwarmToolTruncation,
  WORKFLOW_LONG_SCRIPT_TIMEOUT_NUDGE,
} from "../tools/utils";
import { clearVolatileSecretsForTesting, registerVolatileSecret } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-swarm-tool-result-gate.sqlite";
const TEST_AGENT_ID = "tool-result-test-agent";
const TEST_OVERFLOW_NAMESPACE = mcpOverflowNamespace(TEST_AGENT_ID);

// ── Part 1: finalize pipeline contract ────────────────────────────────────────
// Both channels must be independently self-sufficient and semantically
// identical (see runbooks/mcp-tool-results.md). These tests freeze the
// transform every converted tool relies on.

describe("finalizeSwarmToolResult", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("ok result: text = message, structuredContent has success + message, isError false", () => {
    const result = finalizeSwarmToolResult("some-tool", { ok: true, message: "All good." });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "All good." }]);
    expect(result.structuredContent).toEqual({ success: true, message: "All good." });
  });

  test("error result: isError true, success false", () => {
    const result = finalizeSwarmToolResult("some-tool", { ok: false, message: "It broke." });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ success: false, message: "It broke." });
  });

  test("details and nudge compose into BOTH channels identically", () => {
    const result = finalizeSwarmToolResult("some-tool", {
      ok: false,
      message: "It broke.",
      details: "line 1: kaboom",
      nudge: "Try the other thing.",
    });
    const text = (result.content?.[0] as { text: string }).text;
    // Nudge BEFORE the payload: harnesses truncate long text from the tail,
    // so the steer must not sit behind a potentially-cut rendering.
    expect(text).toBe("It broke.\n\nTry the other thing.\n\nline 1: kaboom");
    expect(result.structuredContent).toMatchObject({
      success: false,
      message: "It broke.",
      details: "line 1: kaboom",
      nudge: "Try the other thing.",
    });
  });

  test("structuredContent is ALWAYS present (opencode SDK client throws otherwise)", () => {
    for (const outcome of [
      { ok: true, message: "yes" },
      { ok: false, message: "no" },
    ] satisfies SwarmToolResult[]) {
      expect(finalizeSwarmToolResult("t", outcome).structuredContent).toBeDefined();
    }
  });

  test("data spreads into structuredContent but cannot clobber the envelope", () => {
    const result = finalizeSwarmToolResult("some-tool", {
      ok: true,
      message: "Saved.",
      data: { count: 3, success: "spoofed", message: "spoofed" },
    });
    expect(result.structuredContent).toMatchObject({ count: 3, success: true, message: "Saved." });
  });

  test("empty message gets a loud non-empty fallback (never a blank text channel)", () => {
    for (const [ok, marker] of [
      [true, "succeeded"],
      [false, "failed"],
    ] as const) {
      const result = finalizeSwarmToolResult("some-tool", { ok, message: "  " });
      const text = (result.content?.[0] as { text: string }).text;
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).toContain(marker);
      expect(
        (result.structuredContent as { message: string }).message.trim().length,
      ).toBeGreaterThan(0);
    }
  });

  test("secrets are scrubbed from message, details, and data at the egress point", () => {
    registerVolatileSecret("sk-super-secret-token-123", "TEST_TOKEN");
    try {
      const result = finalizeSwarmToolResult("some-tool", {
        ok: false,
        message: "Auth failed with sk-super-secret-token-123",
        details: "header was sk-super-secret-token-123",
        data: { token: "sk-super-secret-token-123" },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("sk-super-secret-token-123");
    } finally {
      clearVolatileSecretsForTesting();
    }
  });

  test("allowSecretEgress skips scrubbing for deliberate credential reveals only", () => {
    registerVolatileSecret("xsk_reveal_me_once_456", "TEST_REVEAL");
    try {
      const revealed = finalizeSwarmToolResult("script-apis", {
        ok: true,
        message: "Endpoint created.",
        details: "Bearer token (shown once — save it now): xsk_reveal_me_once_456",
        data: { token: "xsk_reveal_me_once_456" },
        allowSecretEgress: true,
      });
      expect(JSON.stringify(revealed)).toContain("xsk_reveal_me_once_456");

      const scrubbed = finalizeSwarmToolResult("some-tool", {
        ok: true,
        message: "leaky xsk_reveal_me_once_456",
      });
      expect(JSON.stringify(scrubbed)).not.toContain("xsk_reveal_me_once_456");
    } finally {
      clearVolatileSecretsForTesting();
    }
  });

  test("NUDGES map: failed script-run gets the authoring-contract nudge in both channels", () => {
    const result = finalizeSwarmToolResult("script-run", {
      ok: false,
      message: "Script run failed: TypeError: ctx.api is undefined",
    });
    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toContain(SCRIPT_AUTHORING_NUDGE);
    expect((result.structuredContent as { nudge?: string }).nudge).toBe(SCRIPT_AUTHORING_NUDGE);
  });

  test("NUDGES map: timed-out script-run prioritizes durable orchestration", () => {
    const result = finalizeSwarmToolResult("script-run", {
      ok: false,
      message: "Script run failed: timeout",
      data: { status: 200, data: { error: "timeout", durationMs: 30_001 } },
    });
    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toContain(SCRIPT_RUN_TIMEOUT_NUDGE);
    expect(text).not.toContain(SCRIPT_AUTHORING_NUDGE);
    expect((result.structuredContent as { nudge?: string }).nudge).toBe(SCRIPT_RUN_TIMEOUT_NUDGE);
  });

  test("NUDGES map: workflow timeout steer fires strictly above the named threshold", () => {
    for (const [toolName, node] of [
      [
        "create-workflow",
        {
          id: "inline",
          type: "script",
          config: { runtime: "bash", script: "true", timeout: SCRIPT_LONG_TIMEOUT_HINT_MS + 1 },
        },
      ],
      [
        "update-workflow",
        {
          id: "catalog",
          type: "swarm-script",
          config: { scriptName: "report", timeoutMs: SCRIPT_LONG_TIMEOUT_HINT_MS + 1 },
        },
      ],
    ] as const) {
      const result = finalizeSwarmToolResult(toolName, {
        ok: true,
        message: "Workflow saved.",
        data: { longScriptTimeoutHint: findLongScriptTimeoutHint([node]) },
      });
      expect((result.structuredContent as { nudge?: string }).nudge).toBe(
        WORKFLOW_LONG_SCRIPT_TIMEOUT_NUDGE,
      );
    }

    const atThreshold = finalizeSwarmToolResult("patch-workflow", {
      ok: true,
      message: "Workflow saved.",
      data: {
        longScriptTimeoutHint: findLongScriptTimeoutHint([
          {
            id: "catalog",
            type: "swarm-script",
            config: { scriptName: "report", timeoutMs: SCRIPT_LONG_TIMEOUT_HINT_MS },
          },
        ]),
      },
    });
    expect((atThreshold.structuredContent as { nudge?: string }).nudge).toBeUndefined();

    const belowThreshold = finalizeSwarmToolResult("patch-workflow-node", {
      ok: true,
      message: "Workflow saved.",
      data: {
        longScriptTimeoutHint: findLongScriptTimeoutHint([
          {
            id: "inline",
            type: "script",
            config: {
              runtime: "bash",
              script: "true",
              timeout: SCRIPT_LONG_TIMEOUT_HINT_MS - 1,
            },
          },
        ]),
      },
    });
    expect((belowThreshold.structuredContent as { nudge?: string }).nudge).toBeUndefined();
  });

  test("NUDGES map: lookup/transport failures get no authoring nudge", () => {
    // A missing run ID / transport error is not an authoring problem — the
    // (args, ctx) steer would distract from the reported error.
    const notFound = finalizeSwarmToolResult("get-script-run", {
      ok: false,
      message: "Scripts API request failed with 404",
    });
    expect((notFound.structuredContent as { nudge?: string }).nudge).toBeUndefined();

    const typecheck = finalizeSwarmToolResult("script-upsert", {
      ok: false,
      message: "Typecheck failed: TS2345 …",
    });
    expect((typecheck.structuredContent as { nudge?: string }).nudge).toBe(SCRIPT_AUTHORING_NUDGE);
  });

  test("NUDGES map: empty script-search points at seeded examples; non-empty does not", () => {
    // Real proxyScriptsApi shape: data = { status, data: <parsed HTTP body> }.
    const empty = finalizeSwarmToolResult("script-search", {
      ok: true,
      message: "Found 0 script(s).",
      data: { status: 200, data: { results: [] } },
    });
    expect((empty.structuredContent as { nudge?: string }).nudge).toContain("seeded");

    const nonEmpty = finalizeSwarmToolResult("script-search", {
      ok: true,
      message: "Found 1 script(s).",
      data: { status: 200, data: { results: [{ name: "x" }] } },
    });
    expect((nonEmpty.structuredContent as { nudge?: string }).nudge).toBeUndefined();
  });

  test("NUDGES map: app-get steers to the callable surface only when one exists", () => {
    const withSurface = finalizeSwarmToolResult("app-get", {
      ok: true,
      message: 'App "PM Inbox" (a1).',
      data: {
        app: {
          definition: {
            models: {},
            queries: { open: { model: "issue" } },
            actions: { refresh: { kind: "sync" } },
          },
        },
      },
    });
    expect((withSurface.structuredContent as { nudge?: string }).nudge).toContain(
      "callable surface",
    );

    const bare = finalizeSwarmToolResult("app-get", {
      ok: true,
      message: 'App "Bare" (a2).',
      data: { app: { definition: { models: {} } } },
    });
    expect((bare.structuredContent as { nudge?: string }).nudge).toBeUndefined();

    const failed = finalizeSwarmToolResult("app-get", {
      ok: false,
      message: "App a3 not found.",
    });
    expect((failed.structuredContent as { nudge?: string }).nudge).toBeUndefined();
  });

  test("NUDGES map: memory-search rating steer fires only when a result carries a rateHint", () => {
    const withHint = finalizeSwarmToolResult("memory-search", {
      ok: true,
      message: "Found 2 memories.",
      data: {
        results: [{ id: "a" }, { id: "b", rateHint: 'memory_rate(id="b", useful=true|false)' }],
      },
    });
    expect((withHint.structuredContent as { nudge?: string }).nudge).toContain("memory_rate");

    const withoutHint = finalizeSwarmToolResult("memory-search", {
      ok: true,
      message: "Found 1 memories.",
      data: { results: [{ id: "a" }] },
    });
    expect((withoutHint.structuredContent as { nudge?: string }).nudge).toBeUndefined();
  });

  test("data with no details auto-renders into the text channel (completeness guarantee)", () => {
    const result = finalizeSwarmToolResult("some-tool", {
      ok: true,
      message: "Saved.",
      data: { taskId: "t-1", status: "in_progress" },
    });
    const text = (result.content?.[0] as { text: string }).text;
    expect(text).toContain('"taskId": "t-1"');
    expect(text).toContain('"status": "in_progress"');
    // Not duplicated into structuredContent.details — data is already there.
    expect((result.structuredContent as { details?: string }).details).toBeUndefined();

    // Explicit details suppress the fallback (curated rendering wins).
    const curated = finalizeSwarmToolResult("some-tool", {
      ok: true,
      message: "Saved.",
      details: "- t-1: in_progress",
      data: { taskId: "t-1", status: "in_progress" },
    });
    const curatedText = (curated.content?.[0] as { text: string }).text;
    expect(curatedText).toContain("- t-1: in_progress");
    expect(curatedText).not.toContain('"taskId"');
  });

  test("oversized JSON spills the full payload and emits a bounded omission on BOTH channels", () => {
    const blob = "x".repeat(50_000);
    const result = finalizeSwarmToolResult(
      "some-tool",
      {
        ok: true,
        message: "Big payload.",
        data: { blob },
      },
      { agentId: TEST_AGENT_ID },
    );
    const text = (result.content?.[0] as { text: string }).text;
    const structured = result.structuredContent as {
      details?: string;
      truncation?: {
        truncated: true;
        fullValueAt: string;
        originalBytes: number;
        limitBytes: number;
        retrieval: string;
      };
    };

    expect(text).toContain("JSON payload omitted");
    expect(text).toContain('"truncated":true');
    expect(text).not.toContain(`"blob": "${blob.slice(0, 100)}`);
    expect(structured).not.toHaveProperty("blob");
    expect(structured.details).toContain("JSON payload omitted");
    const fullValueAt = structured.truncation!.fullValueAt;
    const retrieval = structured.truncation!.retrieval;
    expect(fullValueAt).toMatch(/^kv:\/\/mcp:overflow:tool-result-test-agent\/v1\/some-tool\//);
    expect(structured.truncation).toMatchObject({
      truncated: true,
      originalBytes: expect.any(Number),
      limitBytes: MCP_RESULT_WIRE_LIMIT_BYTES,
      retrieval: expect.stringContaining("ctx.swarm.kv_get"),
    });
    const key = fullValueAt.replace(`kv://${TEST_OVERFLOW_NAMESPACE}/`, "");
    expect(retrieval).toContain(
      `kv-get({"namespace":"${TEST_OVERFLOW_NAMESPACE}","key":"${key}"})`,
    );
    expect(text).toContain(fullValueAt);
    expect(text).toContain(`"key":"${key}"`);
    expect(structured.details).toContain(fullValueAt);
    expect(structured.details).toContain(`"key":"${key}"`);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MCP_RESULT_WIRE_LIMIT_BYTES,
    );
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MCP_RESULT_WIRE_LIMIT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8")).toBeLessThanOrEqual(
      MCP_RESULT_WIRE_LIMIT_BYTES,
    );

    const stored = getKv(TEST_OVERFLOW_NAMESPACE, key);
    expect(stored?.valueType).toBe("string");
    expect(JSON.parse(String(stored?.value)).outcome.data.blob).toBe(blob);
    expect((stored?.expiresAt ?? 0) - Date.now()).toBeGreaterThan(MCP_OVERFLOW_TTL_MS - 60_000);
  });

  test("script-SDK origin receives the full payload without the model-context ceiling", () => {
    const blob = "x".repeat(50_000);
    const result = finalizeSwarmToolResult(
      "some-tool",
      {
        ok: true,
        message: "Big in-sandbox payload.",
        data: { blob },
      },
      { agentId: TEST_AGENT_ID, callOrigin: "script-sdk" },
    );

    expect((result.structuredContent as { blob?: string }).blob).toBe(blob);
    expect(result.structuredContent).not.toHaveProperty("truncation");
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeGreaterThan(
      MCP_RESULT_WIRE_LIMIT_BYTES,
    );
  });

  test("oversized arrays keep a non-empty prefix and a truthful surviving count", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      ts: String(index),
      text: `message-${index}:${"x".repeat(900)}`,
    }));
    const details = messages.map((message) => message.text).join("\n\n");
    const result = finalizeSwarmToolResult(
      "slack-read",
      {
        ok: true,
        message: "Retrieved 20 message(s).",
        details,
        data: { channelId: "C123", messages },
      },
      { agentId: TEST_AGENT_ID },
    );
    const structured = result.structuredContent as {
      messages: typeof messages;
      message: string;
      truncation: SwarmToolTruncation;
    };

    expect(structured.messages.length).toBeGreaterThan(0);
    expect(structured.messages.length).toBeLessThan(messages.length);
    expect(structured.messages).toEqual(messages.slice(0, structured.messages.length));
    expect(structured.message).toContain(`Retrieved ${structured.messages.length} message(s)`);
    expect(structured.message).toContain("truncated from 20");
    expect(structured.truncation).toMatchObject({
      truncated: true,
      limitBytes: MCP_RESULT_WIRE_LIMIT_BYTES,
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MCP_RESULT_WIRE_LIMIT_BYTES,
    );

    const key = structured.truncation.fullValueAt.replace(`kv://${TEST_OVERFLOW_NAMESPACE}/`, "");
    const stored = getKv(TEST_OVERFLOW_NAMESPACE, key);
    const canonical = JSON.parse(String(stored?.value)) as {
      outcome: { data: { messages: typeof messages } };
    };
    expect(canonical.outcome.data.messages).toEqual(messages);
  });

  test("an oversized scalar sibling cannot make ctx-control drop an array key", () => {
    const result = finalizeSwarmToolResult(
      "some-tool",
      {
        ok: true,
        message: "Retrieved 2 item(s).",
        data: {
          blob: "x".repeat(50_000),
          items: [{ id: 1 }, { id: 2 }],
        },
      },
      { agentId: TEST_AGENT_ID },
    );
    const structured = result.structuredContent as {
      items?: Array<{ id: number }>;
      blob?: string;
      truncation: SwarmToolTruncation;
    };

    expect(structured).toHaveProperty("items");
    expect(structured.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(structured).not.toHaveProperty("blob");
    expect(structured.truncation.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      MCP_RESULT_WIRE_LIMIT_BYTES,
    );
  });

  test("oversized prose keeps a readable prefix + marker + resolvable pointer on both channels", () => {
    const blob = "x".repeat(50_000);
    const result = finalizeSwarmToolResult(
      "some-tool",
      {
        ok: true,
        message: "Big rendered payload.",
        details: `  ${blob}  `,
        data: { blob },
      },
      { agentId: TEST_AGENT_ID },
    );
    const text = (result.content?.[0] as { text: string }).text;
    const structured = result.structuredContent as {
      details?: string;
      truncation?: {
        truncated: true;
        fullValueAt: string;
        originalBytes: number;
        limitBytes: number;
        retrieval: string;
      };
    };

    expect(structured.details).toContain(blob.slice(0, 100));
    expect(structured.details).toContain("[truncated");
    expect(structured.details).toContain(`kv://${TEST_OVERFLOW_NAMESPACE}/`);
    expect(structured.details!.length).toBeLessThan(2_500);
    expect(text).toBe(`Big rendered payload.\n\n${structured.details}`);
    expect(structured).not.toHaveProperty("blob");
    const fullValueAt = structured.truncation!.fullValueAt;
    const retrieval = structured.truncation!.retrieval;
    expect(structured.truncation).toMatchObject({
      truncated: true,
      fullValueAt: expect.stringMatching(/^kv:\/\/mcp:overflow:tool-result-test-agent\//),
      originalBytes: expect.any(Number),
      limitBytes: MCP_RESULT_WIRE_LIMIT_BYTES,
      retrieval: expect.stringContaining("kv-get("),
    });
    expect(text).toContain(fullValueAt);
    expect(text).toContain(retrieval);
    expect(structured.details).toContain(fullValueAt);
    expect(structured.details).toContain(retrieval);
  });

  test("oversized results without an agent identity never spill to the flat namespace", () => {
    const result = finalizeSwarmToolResult("anonymous-tool", {
      ok: true,
      message: "Large anonymous result.",
      data: { blob: "x".repeat(30_000) },
    });
    const text = (result.content?.[0] as { text: string }).text;
    const truncation = (
      result.structuredContent as {
        truncation: { fullValueAt: string; retrieval: string };
      }
    ).truncation;

    expect(truncation.fullValueAt).toBe("unavailable: authenticated agent identity required");
    expect(truncation.retrieval).toContain("authenticated X-Agent-ID");
    expect(text).not.toContain("kv://mcp:overflow/");
  });

  test("details-only overflow is retained in KV and never points at 'not retained'", () => {
    const details = `details-only:${"z".repeat(30_000)}`;
    const result = finalizeSwarmToolResult(
      "details-only-tool",
      {
        ok: true,
        message: "Large prose.",
        details,
      },
      { agentId: TEST_AGENT_ID },
    );
    const structured = result.structuredContent as {
      truncation: { fullValueAt: string; retrieval: string };
    };
    expect(structured.truncation.fullValueAt).not.toContain("not retained");
    const key = structured.truncation.fullValueAt.replace(`kv://${TEST_OVERFLOW_NAMESPACE}/`, "");
    const stored = getKv(TEST_OVERFLOW_NAMESPACE, key);
    expect(JSON.parse(String(stored?.value)).outcome.details).toBe(details);
    expect((result.content?.[0] as { text: string }).text).toContain(
      structured.truncation.retrieval,
    );
  });

  test("spilled non-ASCII payload survives the KV round trip byte-completely", () => {
    const details = `prefix-${"🙂é漢".repeat(5_000)}-suffix`;
    const result = finalizeSwarmToolResult(
      "unicode-tool",
      {
        ok: true,
        message: "Unicode payload.",
        details,
      },
      { agentId: TEST_AGENT_ID },
    );
    const truncation = (
      result.structuredContent as {
        truncation: { fullValueAt: string; retrieval: string };
      }
    ).truncation;
    expect(truncation.retrieval).toMatch(
      /^kv-get\(\{"namespace":"mcp:overflow:tool-result-test-agent","key":"[^"]+"\}\) returns the full value/,
    );
    expect(truncation.retrieval).toContain("ctx.swarm.kv_get");
    const key = truncation.fullValueAt.replace(`kv://${TEST_OVERFLOW_NAMESPACE}/`, "");
    const stored = getKv(TEST_OVERFLOW_NAMESPACE, key);
    expect(JSON.parse(String(stored?.value)).outcome.details).toBe(details);
  });

  test("ctx-control persists only scrubbed overflow content", () => {
    registerVolatileSecret("sk-overflow-secret-789", "OVERFLOW_TEST");
    try {
      const result = finalizeSwarmToolResult(
        "secret-overflow",
        {
          ok: true,
          message: "Large result.",
          data: { blob: `sk-overflow-secret-789:${"x".repeat(30_000)}` },
        },
        { agentId: TEST_AGENT_ID },
      );
      const fullValueAt = (
        result.structuredContent as {
          truncation: { fullValueAt: string };
        }
      ).truncation.fullValueAt;
      const key = fullValueAt.replace(`kv://${TEST_OVERFLOW_NAMESPACE}/`, "");
      const stored = getKv(TEST_OVERFLOW_NAMESPACE, key);
      expect(String(stored?.value)).not.toContain("sk-overflow-secret-789");
      expect(String(stored?.value)).toContain("[REDACTED:OVERFLOW_TEST]");
    } finally {
      clearVolatileSecretsForTesting();
    }
  });

  test("whitespace-only details fall back to a rendered data preview", () => {
    const result = finalizeSwarmToolResult("some-tool", {
      ok: true,
      message: "Saved.",
      details: " \n\t ",
      data: { taskId: "t-whitespace" },
    });
    const text = (result.content?.[0] as { text: string }).text;

    expect(text).toContain('"taskId": "t-whitespace"');
    expect((result.structuredContent as { details?: string }).details).toBeUndefined();
  });

  test("an explicit tool-provided nudge wins over the central map", () => {
    const result = finalizeSwarmToolResult("script-run", {
      ok: false,
      message: "failed",
      nudge: "Custom nudge.",
    });
    expect((result.structuredContent as { nudge?: string }).nudge).toBe("Custom nudge.");
  });
});

// ── Part 2: output-schema audit over every registered tool ────────────────────
// Output schemas are validated twice (our server SDK + opencode's client), and
// plain z.object emits `additionalProperties: false`. A strict or
// format-pinned OUTPUT schema can reject an honest response AFTER the write
// landed (the -32602-after-write trap). Inputs may stay strict — they fail
// before side effects.

type ZodNode = {
  _zod?: {
    def?: {
      type?: string;
      format?: string;
      checks?: Array<{ _zod?: { def?: { check?: string; format?: string } } }>;
      shape?: Record<string, unknown>;
      catchall?: ZodNode;
      element?: ZodNode;
      innerType?: ZodNode;
      options?: ZodNode[];
      keyType?: ZodNode;
      valueType?: ZodNode;
      in?: ZodNode;
      out?: ZodNode;
      items?: ZodNode[];
    };
  };
};

function auditOutputSchema(
  node: unknown,
  path: string,
  violations: string[],
  seen = new Set<unknown>(),
): void {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  const def = (node as ZodNode)._zod?.def;
  if (!def) return;

  if (def.type === "string" && def.format) {
    violations.push(`${path}: string format pin \`${def.format}\` on an output field`);
  }
  for (const check of def.checks ?? []) {
    if (check._zod?.def?.check === "string_format") {
      violations.push(
        `${path}: string format pin \`${check._zod.def.format ?? "unknown"}\` on an output field`,
      );
    }
  }
  if (def.type === "object") {
    const catchallType = def.catchall?._zod?.def?.type;
    if (catchallType === "never") {
      violations.push(`${path}: strict object (catchall never) in an output schema`);
    } else if (!def.catchall) {
      violations.push(
        `${path}: non-loose object in an output schema (plain z.object emits additionalProperties: false — use z.looseObject / swarmToolOutputSchema)`,
      );
    }
    for (const [key, child] of Object.entries(def.shape ?? {})) {
      auditOutputSchema(child, `${path}.${key}`, violations, seen);
    }
  }
  for (const child of [
    def.element,
    def.innerType,
    def.keyType,
    def.valueType,
    def.in,
    def.out,
    def.catchall,
  ]) {
    if (child) auditOutputSchema(child, path, violations, seen);
  }
  for (const child of [...(def.options ?? []), ...(def.items ?? [])]) {
    auditOutputSchema(child, path, violations, seen);
  }
}

type RegisteredTool = { outputSchema?: unknown };

describe("registered tool output schemas", () => {
  let tools: Record<string, RegisteredTool>;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
    initDb(TEST_DB_PATH);
    const server = createServer({ fullSurface: true });
    tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // ignore
      }
    }
  });

  test("every declared output schema is loose, unpinned, and envelope-compatible", () => {
    const failures: string[] = [];
    for (const [name, tool] of Object.entries(tools)) {
      if (!tool.outputSchema) continue;
      const schema = tool.outputSchema as ZodNode & {
        safeParse?: (value: unknown) => { success: boolean; error?: unknown };
      };

      const violations: string[] = [];
      auditOutputSchema(schema, name, violations);
      failures.push(...violations);

      // The registrar writes { success, message, details?, nudge? } for every
      // result — including error results that carry no tool data. A schema
      // that rejects the bare envelope rejects honest error reporting.
      const envelopeParse = schema.safeParse?.({
        success: false,
        message: "some error",
        details: "detail",
        nudge: "nudge",
        extraDataKey: { anything: true },
      });
      if (envelopeParse && !envelopeParse.success) {
        failures.push(
          `${name}: output schema rejects the bare result envelope — all tool-data fields must be optional`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
