import { describe, expect, test } from "bun:test";
import { isRowNavigationSuppressed } from "./grid-row-click";

/** A target whose ancestor chain matches only the given selectors. */
function targetInside(...matches: string[]) {
  return {
    closest: (selector: string) =>
      selector.split(",").some((part) => matches.includes(part.trim())) ? {} : null,
  };
}

describe("isRowNavigationSuppressed", () => {
  test("a click in the favorite column never navigates, even off the button", () => {
    expect(isRowNavigationSuppressed(targetInside('[col-id="favorite"]') as never)).toBe(true);
  });

  test("buttons, links and switches do not navigate", () => {
    for (const match of ["button", "a", '[data-slot="switch"]']) {
      expect(isRowNavigationSuppressed(targetInside(match) as never)).toBe(true);
    }
  });

  test("a plain cell click navigates", () => {
    expect(isRowNavigationSuppressed(targetInside() as never)).toBe(false);
    expect(isRowNavigationSuppressed(null)).toBe(false);
  });
});
