import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bareToolName,
  controlReached,
  countSwarmTools,
  hasControlResult,
  inputTokens,
  toolNames,
  turnOne,
  withSessionDirs,
} from "../../scripts/probe-tool-schema-tokens";

describe("probe-tool-schema-tokens", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("matches swarm tools under every harness naming", () => {
    const swarm = new Set(["get_swarm", "store_progress"]);
    expect(bareToolName("mcp__agent_swarm__get_swarm")).toBe("get_swarm");
    expect(bareToolName("agent-swarm_store-progress")).toBe("store_progress");
    expect(
      countSwarmTools(["get-swarm", "mcp__agent_swarm__store_progress", "bash", "read"], swarm),
    ).toBe(2);
  });

  test("lists tools in chat-completions and namespaced responses bodies", () => {
    expect(toolNames({ tools: [{ type: "function", function: { name: "get-swarm" } }] })).toEqual([
      "get-swarm",
    ]);
    const responses = {
      input: [
        {
          type: "additional_tools",
          tools: [{ type: "namespace", name: "functions", tools: [{ name: "exec" }] }],
        },
      ],
      tools: [{ name: "wait" }],
    };
    expect(toolNames(responses).sort()).toEqual(["exec", "wait"]);
  });

  test("reads the last reported input token count from a stream", () => {
    const sse = 'data: {"usage":null}\n\ndata: {"usage":{"prompt_tokens":90776}}\n';
    expect(inputTokens(sse)).toBe(90776);
    expect(inputTokens('{"response":{"usage":{"input_tokens":16629}}}')).toBe(16629);
    expect(inputTokens("data: [DONE]")).toBeNull();
  });

  test("turn one skips side requests for other models", () => {
    dir = mkdtempSync(join(tmpdir(), "probe-tool-schema-"));
    writeFileSync(join(dir, "req-1.json"), JSON.stringify({ model: "openai/gpt-6-luna" }));
    writeFileSync(join(dir, "res-1.txt"), '{"usage":{"prompt_tokens":453}}');
    writeFileSync(
      join(dir, "req-2.json"),
      JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", tools: [{ name: "bash" }] }),
    );
    writeFileSync(join(dir, "res-2.txt"), '{"usage":{"prompt_tokens":33115}}');
    expect(turnOne(dir, "openrouter/deepseek/deepseek-v4.1-flash")).toEqual({
      tokens: 33115,
      names: ["bash"],
    });
  });

  const found = "Found 5 agent(s) in the swarm. Requested by session: s1";

  test("control passes only on a get-swarm tool output", () => {
    dir = mkdtempSync(join(tmpdir(), "probe-tool-schema-"));
    // The schema alone carries "in the swarm" in get-swarm's description.
    const schemaOnly = {
      model: "m",
      tools: [
        {
          type: "function",
          function: { name: "agent-swarm_get-swarm", description: "Lists agents in the swarm." },
        },
      ],
      messages: [{ role: "user", content: "Call get-swarm. Found 5 agent(s) in the swarm." }],
    };
    expect(hasControlResult(schemaOnly)).toBe(false);
    writeFileSync(join(dir, "req-1.json"), JSON.stringify(schemaOnly));
    expect(controlReached(dir)).toBe(false);

    const chat = {
      ...schemaOnly,
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "c1", type: "function", function: { name: "agent-swarm_get-swarm" } }],
        },
        { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: found }] },
      ],
    };
    expect(hasControlResult(chat)).toBe(true);
    writeFileSync(join(dir, "req-2.json"), JSON.stringify(chat));
    expect(controlReached(dir)).toBe(true);
  });

  test("control reads Responses items and rejects other tools and failed calls", () => {
    const responses = (name: string, output: string) => ({
      input: [
        { type: "function_call", name, call_id: "call_1", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output },
      ],
    });
    expect(hasControlResult(responses("mcp__agent_swarm__get_swarm", found))).toBe(true);
    expect(hasControlResult(responses("mcp__agent_swarm__get_tasks", found))).toBe(false);
    expect(hasControlResult(responses("mcp__agent_swarm__get_swarm", "Agent ID required."))).toBe(
      false,
    );
    // An output for a different call id does not count.
    const mismatched = responses("mcp__agent_swarm__get_swarm", found);
    mismatched.input[1] = { type: "function_call_output", call_id: "call_2", output: found };
    expect(hasControlResult(mismatched)).toBe(false);
  });

  test("session dirs: home is removed on success and on error, captures stay", async () => {
    dir = mkdtempSync(join(tmpdir(), "probe-tool-schema-"));
    let home = "";
    const capDir = await withSessionDirs(dir, "ok", async (cap, h) => {
      home = h;
      writeFileSync(join(h, "config.toml"), "x");
      writeFileSync(join(cap, "req-1.json"), "{}");
      return cap;
    });
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(capDir, "req-1.json"))).toBe(true);

    await expect(
      withSessionDirs(dir, "boom", async (cap, h) => {
        home = h;
        writeFileSync(join(h, "config.toml"), "x");
        writeFileSync(join(cap, "req-1.json"), "{}");
        throw new Error("codex exec exited 1");
      }),
    ).rejects.toThrow("codex exec exited 1");
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(dir, "boom-cap", "req-1.json"))).toBe(true);
  });
});
