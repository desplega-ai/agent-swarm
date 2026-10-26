import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bareToolName,
  controlReached,
  countSwarmTools,
  inputTokens,
  toolNames,
  turnOne,
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
    expect(controlReached(dir)).toBe(false);
    writeFileSync(join(dir, "req-3.json"), '{"content":"Found 5 agent(s) in the swarm."}');
    expect(controlReached(dir)).toBe(true);
  });
});
