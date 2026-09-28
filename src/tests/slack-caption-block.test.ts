import { describe, expect, test } from "bun:test";
import { buildCaptionBlock, MAX_CONTEXT_ELEMENTS, MAX_CONTEXT_TEXT_LENGTH } from "../slack/blocks";

type Caption = { type: string; elements: { type: string; text: string }[] };

const texts = (block: unknown) => (block as Caption).elements.map((element) => element.text);

describe("buildCaptionBlock", () => {
  test("renders a heading and items as one context element", () => {
    expect(buildCaptionBlock(["<https://a.test|[1]> A", "[2] B"], { heading: "Sources" })).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Sources: <https://a.test|[1]> A · [2] B" }],
    });
  });

  test("returns undefined when there is nothing to show", () => {
    expect(buildCaptionBlock([])).toBeUndefined();
    expect(buildCaptionBlock([], { heading: "Sources" })).toBeUndefined();
  });

  test("splits across elements so no text object exceeds Slack's limit", () => {
    const item = "x".repeat(1_000);
    const block = buildCaptionBlock([item, item, item, item], { heading: "Sources" });
    const elements = texts(block);
    expect(elements.every((text) => text.length <= MAX_CONTEXT_TEXT_LENGTH)).toBe(true);
    expect(elements.join(" ").split("x".repeat(1_000))).toHaveLength(5);
    expect(elements[0]?.startsWith("Sources: ")).toBe(true);
  });

  test("collapses overflow past the element limit into a linked +N more", () => {
    const items = Array.from({ length: 50 }, (_, index) => `${index}`.padEnd(2_000, "y"));
    const elements = texts(
      buildCaptionBlock(items, { heading: "Sources", moreUrl: "https://app.test/tasks/1" }),
    );
    expect(elements).toHaveLength(MAX_CONTEXT_ELEMENTS);
    expect(elements.every((text) => text.length <= MAX_CONTEXT_TEXT_LENGTH)).toBe(true);
    const shown = MAX_CONTEXT_ELEMENTS - 1;
    expect(elements.at(-1)).toBe(`<https://app.test/tasks/1|+${items.length - shown} more>`);
  });

  test("exactly filling the element limit adds no +N more", () => {
    const items = Array.from({ length: MAX_CONTEXT_ELEMENTS }, () => "z".repeat(2_000));
    const elements = texts(buildCaptionBlock(items));
    expect(elements).toHaveLength(MAX_CONTEXT_ELEMENTS);
    expect(elements.some((text) => text.includes("more"))).toBe(false);
  });

  test("an item too long for one text object is counted, never split mid-link", () => {
    const tooLong = `<https://a.test/${"p".repeat(MAX_CONTEXT_TEXT_LENGTH)}|[1]> A`;
    expect(texts(buildCaptionBlock([tooLong, "[2] B"], { heading: "Sources" }))).toEqual([
      "Sources: [2] B",
      "+1 more",
    ]);
    expect(texts(buildCaptionBlock([tooLong], { heading: "Sources" }))).toEqual([
      "Sources:",
      "+1 more",
    ]);
  });
});
