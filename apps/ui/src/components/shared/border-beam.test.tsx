import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias.
mock.module("@/lib/utils", () => require("../../lib/utils"));
const { BorderBeam } = await import("./border-beam");

/** The ring's style declarations, in the order the browser applies them. */
function ringDeclarations(): string[] {
  const html = renderToStaticMarkup(<BorderBeam />);
  const style = html.match(/style="([^"]*mask[^"]*)"/)?.[1] ?? "";
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration.includes("mask"));
}

describe("BorderBeam ring mask", () => {
  // Firefox treats `-webkit-mask` as an alias of the `mask` shorthand, which
  // resets `mask-composite` to `add`, and it rejects `xor`. A prefixed
  // declaration after the standard pair leaves no cutout, so the whole beam
  // gradient covers the card.
  test("the standard mask pair comes after every prefixed declaration", () => {
    const declarations = ringDeclarations();
    const lastPrefixed = declarations.findLastIndex((d) => d.startsWith("-webkit-mask"));
    const firstStandard = declarations.findIndex((d) => d.startsWith("mask"));
    expect(lastPrefixed).toBeGreaterThanOrEqual(0);
    expect(firstStandard).toBeGreaterThan(lastPrefixed);
    expect(declarations.at(-1)).toBe("mask-composite:exclude");
  });
});
