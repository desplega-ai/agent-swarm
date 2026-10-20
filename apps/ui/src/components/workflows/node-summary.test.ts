import { describe, expect, test } from "bun:test";
import { systemOneSummary } from "./node-summary";

describe("systemOneSummary", () => {
  test("a node with no provider shows the configured default and its model", () => {
    expect(systemOneSummary({}, "cloudflare")).toBe("cloudflare · clef");
  });

  test("with no configured default it stays typesafe", () => {
    expect(systemOneSummary({})).toBe("typesafe · jev-latest");
  });

  test("a node that names its provider and model keeps them", () => {
    expect(systemOneSummary({ provider: "openrouter" }, "cloudflare")).toBe(
      "openrouter · ~typesafe/jev-latest",
    );
    expect(systemOneSummary({ provider: "cloudflare", model: "clef-flash" })).toBe(
      "cloudflare · clef-flash",
    );
  });

  test("a host with no default model says so", () => {
    expect(systemOneSummary({ provider: "laya" })).toBe("laya · default model");
  });
});
