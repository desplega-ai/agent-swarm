import { describe, expect, test } from "bun:test";
import { formatRelative } from "./relative-time";

const ago = (ms: number) => new Date(Date.now() - ms);

describe("formatRelative", () => {
  test("reads 'just now' for the whole first minute", () => {
    expect(formatRelative(ago(5_000))).toBe("just now");
    expect(formatRelative(ago(45_000))).toBe("just now");
    expect(formatRelative(ago(59_000))).toBe("just now");
  });

  test("counts minutes and hours after that", () => {
    expect(formatRelative(ago(90_000))).toBe("1m ago");
    expect(formatRelative(ago(3 * 3_600_000))).toBe("3h ago");
  });
});
