import { afterEach, describe, expect, test } from "bun:test";
import { getRegisteredRaters } from "../be/memory/raters/registry";

const original = process.env.MEMORY_RATERS;
afterEach(() => {
  if (original === undefined) delete process.env.MEMORY_RATERS;
  else process.env.MEMORY_RATERS = original;
});

describe("memory rater defaults", () => {
  test.each([
    [undefined, ["implicit-citation", "explicit-self"]],
    ["", ["noop"]],
    ["  ", ["noop"]],
    ["llm", ["llm"]],
    ["explicit-self,llm", ["explicit-self", "llm"]],
    [" implicit-citation , llm ", ["implicit-citation", "llm"]],
  ] as const)("registry resolves %s", (value, expected) => {
    if (value === undefined) delete process.env.MEMORY_RATERS;
    else process.env.MEMORY_RATERS = value;
    expect(getRegisteredRaters().map((rater) => rater.name)).toEqual([...expected]);
  });
});
