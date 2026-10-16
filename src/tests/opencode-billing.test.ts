import { describe, expect, test } from "bun:test";
import { OpenRouterBilling, parseOpenRouterBilledCost } from "../providers/opencode-billing";

describe("parseOpenRouterBilledCost", () => {
  test("reads usage.cost from a non-streamed JSON body", () => {
    expect(parseOpenRouterBilledCost('{"id":"gen-1","usage":{"cost":0.0042}}')).toBe(0.0042);
  });

  test("a BYOK cost is only OpenRouter's fee, so it is not the bill", () => {
    expect(parseOpenRouterBilledCost('{"usage":{"cost":0.0001,"is_byok":true}}')).toBeNull();
  });

  test("a stream without usage has no billed cost", () => {
    expect(parseOpenRouterBilledCost('data: {"choices":[]}\n\ndata: [DONE]\n\n')).toBeNull();
  });
});

describe("OpenRouterBilling", () => {
  test("no observed request reports nothing", async () => {
    expect(await new OpenRouterBilling().settle(10)).toBeNull();
  });

  test("a body still streaming at the deadline leaves the bill incomplete", async () => {
    const billing = new OpenRouterBilling();
    billing.observe(new Response(new ReadableStream({ start() {} })));
    expect(await billing.settle(10)).toEqual({ costUsd: 0, complete: false });
  });
});
