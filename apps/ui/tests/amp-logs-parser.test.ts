import { describe, expect, test } from "bun:test";
import { itemsToParsedMessages, normalizeSessionLogs } from "../src/logs-parser";
import type { ProviderMetaBlock } from "../src/logs-parser/types";
import fixture from "./fixtures/amp-qa-sessions.json";

describe("amp reader", () => {
  // Real rows persisted by a worker running `amp -x --stream-json` on the `low`
  // mode: the swarm task calls store-progress through Amp's code_exec.
  test("real persisted rows render text, a paired tool call and the result with no unknown rows", () => {
    const parsed = normalizeSessionLogs(fixture);
    expect(parsed.gate).toEqual({ total: 8, ok: 8, bad: 0, passed: true });
    expect(parsed.items.some((item) => item.kind === "unknown")).toBe(false);
    expect(parsed.items.every((item) => item.cli === "amp")).toBe(true);
    expect(parsed.pairing.paired).toBe(1);
    expect(parsed.pairing.orphanCalls).toEqual([]);
    expect(parsed.pairing.orphanResults).toEqual([]);

    const call = parsed.items.find((item) => item.kind === "tool_call");
    expect(call?.tool?.name).toBe("code_exec");
    expect(JSON.stringify(call?.tool?.input)).toContain("store_progress");
    const texts = parsed.items.filter((item) => item.kind === "text").map((item) => item.role);
    expect(texts).toEqual(["user", "assistant"]);
  });

  test("the model the adapter asked for and the model Amp ran both show as lifecycle rows", () => {
    const blocks = itemsToParsedMessages(normalizeSessionLogs(fixture).items).flatMap(
      (message) => message.content,
    );
    const lifecycle = blocks.filter(
      (block): block is ProviderMetaBlock =>
        block.type === "provider_meta" && block.kind === "lifecycle",
    );
    const subtypes = lifecycle.map((block) => block.data.subtype);
    expect(subtypes).toContain("model.selected");
    expect(subtypes).toContain("model.resolved");
    expect(lifecycle.find((block) => block.data.subtype === "model.resolved")?.data.model).toBe(
      "accounts/fireworks/models/glm-5p3-flash",
    );
    expect(blocks.some((block) => block.type === "provider_meta" && block.kind === "result")).toBe(
      true,
    );
  });
});
