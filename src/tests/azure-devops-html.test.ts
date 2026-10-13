import { describe, expect, test } from "bun:test";
import { htmlToText } from "../azure-devops/html";

describe("htmlToText", () => {
  test("strips tags, decodes entities, keeps block breaks", () => {
    expect(htmlToText("<div>a &amp; b</div><div>&lt;c&gt;&nbsp;d</div>")).toBe("a & b\n<c> d");
  });

  test("handles empty input", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText("")).toBe("");
  });
});
