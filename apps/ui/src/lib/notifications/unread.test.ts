import { describe, expect, test } from "bun:test";
import { totalUnread, unreadBadgeLabel } from "./unread";

describe("totalUnread", () => {
  test("counts only the static notifications without a mentions source", () => {
    expect(totalUnread({ staticUnread: 1, mentionsUnread: null })).toBe(1);
    expect(totalUnread({ staticUnread: 0, mentionsUnread: null })).toBe(0);
  });

  test("adds unread mentions when the source is active", () => {
    expect(totalUnread({ staticUnread: 1, mentionsUnread: 2 })).toBe(3);
    expect(totalUnread({ staticUnread: 0, mentionsUnread: 0 })).toBe(0);
  });

  test("counts mentions alone when there is no swarm user", () => {
    expect(totalUnread({ staticUnread: 0, mentionsUnread: 4 })).toBe(4);
  });
});

describe("unreadBadgeLabel", () => {
  test("caps at 9+", () => {
    expect(unreadBadgeLabel(1)).toBe("1");
    expect(unreadBadgeLabel(9)).toBe("9");
    expect(unreadBadgeLabel(10)).toBe("9+");
  });
});
