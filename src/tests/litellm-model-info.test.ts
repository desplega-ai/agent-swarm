import { expect, test } from "bun:test";
import { parseLiteLLMModelInfo } from "../utils/litellm-model-info";

const row = (model_info: unknown, model_name = "example-large-chat") => ({
  model_name,
  model_info,
});
const parse = (data: unknown[]) => parseLiteLLMModelInfo({ data }, "example-large-chat");

test("extracts only exact alias limits and never ambiguous max_tokens or secrets", () => {
  expect(
    parse([
      row({
        max_input_tokens: 922000,
        max_output_tokens: 128000,
        max_tokens: 128000,
        api_key: "secret",
      }),
      { model_name: "other", model_info: { id: "example-large-chat", max_input_tokens: 1 } },
    ]),
  ).toEqual({ input: 922000, output: 128000 });
  expect(parse([row({ max_tokens: 128000 })])).toBeUndefined();
  expect(parse([row({ max_input_tokens: 1 }, "example-large-chat-suffix")])).toBeUndefined();
});
test("all deployments must cover a bound; uses minimum, never an unlimited missing row", () => {
  expect(
    parse([
      row({ max_input_tokens: 922000, max_output_tokens: 128000 }),
      row({ max_input_tokens: 800000, max_output_tokens: 64000 }),
    ]),
  ).toEqual({ input: 800000, output: 64000 });
  expect(
    parse([
      row({ max_input_tokens: 922000, max_output_tokens: 128000 }),
      row({ max_input_tokens: 800000 }),
    ]),
  ).toEqual({ input: 800000 });
  expect(parse([row({ max_input_tokens: 922000 }), row(null)])).toBeUndefined();
});
test("invalid numbers and non-chat modes cannot establish capacity", () => {
  for (const value of [0, -1, Infinity, NaN, "922000", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(parse([row({ max_input_tokens: value })])).toBeUndefined();
  }
  expect(parse([row({ mode: "embedding", max_input_tokens: 922000 })])).toBeUndefined();
});
test("rejects malformed envelopes and excessive row counts", () => {
  for (const body of [null, [], {}, { data: {} }, { data: Array(10001).fill({}) }]) {
    expect(() => parseLiteLLMModelInfo(body, "example-large-chat")).toThrow("metadata");
  }
});
