import { describe, expect, test } from "bun:test";
import { SWIPE_THRESHOLD_PX, swipeMode, swipeOffset } from "./use-swipe-row";

describe("swipeMode", () => {
  test("has no direction under 8 px", () => {
    expect(swipeMode(0, 0)).toBeNull();
    expect(swipeMode(7, -7)).toBeNull();
    expect(swipeMode(-7, 7)).toBeNull();
  });

  test("a mostly sideways move is a swipe, either way", () => {
    expect(swipeMode(8, 0)).toBe("swipe");
    expect(swipeMode(-20, 10)).toBe("swipe");
  });

  test("a vertical or diagonal move is a scroll", () => {
    expect(swipeMode(0, 8)).toBe("scroll");
    expect(swipeMode(10, 10)).toBe("scroll");
    // Sideways must beat vertical by 1.2 times.
    expect(swipeMode(12, 10)).toBe("scroll");
    expect(swipeMode(13, 10)).toBe("swipe");
  });
});

describe("swipeOffset", () => {
  test("follows the finger up to the threshold", () => {
    expect(swipeOffset(40, 390)).toBe(40);
    expect(swipeOffset(-SWIPE_THRESHOLD_PX, 390)).toBe(-SWIPE_THRESHOLD_PX);
  });

  test("follows more slowly past the threshold", () => {
    expect(swipeOffset(130, 390)).toBe(SWIPE_THRESHOLD_PX + 50 * 0.6);
    expect(swipeOffset(-130, 390)).toBe(-(SWIPE_THRESHOLD_PX + 50 * 0.6));
  });

  test("never leaves the row's width", () => {
    expect(swipeOffset(2000, 390)).toBe(390);
    expect(swipeOffset(-2000, 390)).toBe(-390);
  });
});
