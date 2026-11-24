import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter, type ThreadEvent } from "../providers/codex-adapter";
import { toCodexOutputSchema } from "../providers/codex-output-schema";
import type { ProviderEvent } from "../providers/types";

describe("toCodexOutputSchema", () => {
  test("closes every object and makes optional properties nullable", () => {
    expect(
      toCodexOutputSchema({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["findings"],
        properties: {
          findings: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string", description: "path" },
                severity: { type: "string", enum: ["nit", "bug"] },
              },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["findings"],
      additionalProperties: false,
      properties: {
        findings: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["file", "severity"],
            additionalProperties: false,
            properties: {
              file: { type: "string", description: "path" },
              severity: { anyOf: [{ type: "string", enum: ["nit", "bug"] }, { type: "null" }] },
            },
          },
        },
      },
    });
  });

  test.each([
    ["an open object", { type: "object", properties: { meta: { type: "object" } } }],
    ["an array without items", { type: "object", properties: { list: { type: "array" } } }],
    ["additionalProperties: true", { type: "object", properties: {}, additionalProperties: true }],
    ["oneOf", { type: "object", properties: { v: { oneOf: [{ type: "string" }] } } }],
    ["a property with no type", { type: "object", properties: { v: {} } }],
    ["a required name with no property", { type: "object", required: ["v"], properties: {} }],
    ["a non-object root", { type: "array", items: { type: "string" } }],
  ])("returns undefined for %s", (_, schema) => {
    expect(toCodexOutputSchema(schema)).toBeUndefined();
  });
});

describe("CodexSession outputSchema", () => {
  const tmpLogDir = mkdtempSync(join(tmpdir(), "codex-output-schema-"));
  const schema = {
    type: "object",
    required: ["verdict"],
    properties: { verdict: { type: "string" }, note: { type: "string" } },
  };
  let prevSkipEnv: string | undefined;
  let taskRow: { status: string; output?: string };
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    prevSkipEnv = process.env.SKIP_SESSION_SUMMARY;
    process.env.SKIP_SESSION_SUMMARY = "1";
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        Response.json(new URL(req.url).pathname === "/api/tasks/task-schema" ? taskRow : {}),
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(tmpLogDir, { recursive: true, force: true });
    if (prevSkipEnv === undefined) delete process.env.SKIP_SESSION_SUMMARY;
    else process.env.SKIP_SESSION_SUMMARY = prevSkipEnv;
  });

  /** A thread that records each turn and plays `turns[i]` for the i-th one. */
  async function run(turns: ThreadEvent[][], outputSchema?: Record<string, unknown>) {
    const calls: Array<{ input: string; outputSchema?: Record<string, unknown> }> = [];
    const thread = {
      id: "thread-schema",
      async steer() {},
      async interrupt() {},
      async close() {},
      async runStreamed(input: string, turnSchema?: Record<string, unknown>) {
        const events = turns[calls.length] ?? [];
        calls.push({ input, outputSchema: turnSchema });
        return {
          events: (async function* () {
            yield* events;
          })(),
        };
      },
    };
    const adapter = new CodexAdapter({
      bypassSubprocess: true,
      threadFactory: () => thread as never,
    });
    const session = await adapter.createSession({
      prompt: "hello",
      systemPrompt: "",
      model: "gpt-5.4",
      role: "worker",
      agentId: "agent-test",
      taskId: "task-schema",
      apiUrl: server.url.origin,
      apiKey: "test",
      cwd: "",
      logFile: join(tmpLogDir, `${crypto.randomUUID()}.log`),
      env: { PATH: process.env.PATH ?? "", HOME: tmpLogDir, CODEX_HOME: tmpLogDir },
      outputSchema,
    });
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();
    return { calls, emitted, result };
  }

  const said = (text: string): ThreadEvent[] => [
    { type: "item.completed", item: { id: crypto.randomUUID(), type: "agent_message", text } },
    {
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    },
  ];

  test("sends the strict-mode schema on the turn and ends on a matching answer", async () => {
    taskRow = { status: "in_progress" };
    const { calls, result } = await run([said('{"verdict":"ok","note":null}')], schema);
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.outputSchema).toEqual({
      type: "object",
      required: ["verdict", "note"],
      additionalProperties: false,
      properties: {
        verdict: { type: "string" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
  });

  test("sends no schema and no reprompt for a task without outputSchema", async () => {
    taskRow = { status: "in_progress" };
    const { calls } = await run([said("I'm sorry, but I couldn't complete the review.")]);
    expect(calls).toEqual([{ input: "hello", outputSchema: undefined }]);
  });

  test("reprompts once in the same session when the final message is prose", async () => {
    taskRow = { status: "in_progress" };
    const prose = said("I'm sorry, but I couldn't complete the requested review.");
    const { calls, result } = await run([prose, prose, prose], schema);
    expect(result.exitCode).toBe(0);
    expect(calls.map((c) => c.input)).toEqual([
      "hello",
      "Your last message was not valid JSON for the required schema. Call store-progress with output matching it.",
    ]);
    expect(calls[1]?.outputSchema).toEqual(calls[0]?.outputSchema);
  });

  test("does not reprompt when store-progress already gave the task its output", async () => {
    taskRow = { status: "completed", output: '{"verdict":"ok"}' };
    const { calls } = await run([said("Done.")], schema);
    expect(calls).toHaveLength(1);
  });

  test("reruns the turn without the schema when the API rejects it", async () => {
    taskRow = { status: "in_progress" };
    const rejection =
      "Invalid schema for response_format 'codex_output_schema': ... (code invalid_json_schema)";
    const { calls, result } = await run(
      [
        [
          { type: "error", message: rejection, willRetry: false },
          { type: "turn.failed", error: { message: rejection } },
        ],
        said('{"verdict":"ok"}'),
      ],
      schema,
    );
    expect(result.exitCode).toBe(0);
    expect(result.isError).toBe(false);
    expect(calls.map((c) => [c.input, c.outputSchema === undefined])).toEqual([
      ["hello", false],
      ["hello", true],
    ]);
  });
});
