import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { createServer } from "../server";
import {
  finalizeSwarmToolResult,
  SCRIPT_AUTHORING_NUDGE,
  type SwarmToolResult,
} from "../tools/utils";
import { clearVolatileSecretsForTesting, registerVolatileSecret } from "../utils/secret-scrubber";

const TEST_DB_PATH = "./test-swarm-tool-result-gate.sqlite";

// ── Part 1: finalize pipeline contract ────────────────────────────────────────
// Both channels must be independently self-sufficient and semantically
// identical (see runbooks/mcp-tool-results.md). These tests freeze the
// transform every converted tool relies on.

describe("finalizeSwarmToolResult", () => {
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
    expect(text).toBe("It broke.\n\nline 1: kaboom\n\nTry the other thing.");
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

  test("auto-rendered data fallback is capped for the tightest harness budget", () => {
    const result = finalizeSwarmToolResult("some-tool", {
      ok: true,
      message: "Big payload.",
      data: { blob: "x".repeat(50_000) },
    });
    const text = (result.content?.[0] as { text: string }).text;
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("[truncated");
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
