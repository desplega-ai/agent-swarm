import { describe, expect, test } from "bun:test";
import { unreadBadgeLabel } from "./unread";

describe("unreadBadgeLabel", () => {
  test("caps at 9+", () => {
    expect(unreadBadgeLabel(1)).toBe("1");
    expect(unreadBadgeLabel(9)).toBe("9");
    expect(unreadBadgeLabel(10)).toBe("9+");
  });
});
