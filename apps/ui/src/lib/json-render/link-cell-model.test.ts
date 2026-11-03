import { describe, expect, test } from "bun:test";
import {
  cellHasControls,
  isClipped,
  isLinkColumn,
  isPhoneControlColumn,
  linkCell,
  TIP_MAX_CHARS,
  tipText,
} from "./link-cell-model";

const ROW = {
  repo: "agent-swarm",
  number: 2605,
  url: "https://github.com/desplega-ai/agent-swarm/pull/2605",
  workUrl: "",
  title: "feat(apps): smart links",
};

describe("linkCell", () => {
  test("a link column's own value is the URL and the label is derived", () => {
    expect(linkCell({ value: ROW.url, row: ROW })).toEqual({ target: ROW.url, label: null });
  });

  test("href reads the URL from another row field and keeps the cell text as the label", () => {
    expect(linkCell({ value: 2605, row: ROW, href: "url", text: "agent-swarm#2605" })).toEqual({
      target: ROW.url,
      label: "agent-swarm#2605",
    });
  });

  test("linkLabel is a template over the row and wins over the cell text", () => {
    expect(
      linkCell({
        value: ROW.url,
        row: ROW,
        linkLabel: "{{repo}}#{{number}}",
        text: "something else",
      }),
    ).toEqual({ target: ROW.url, label: "agent-swarm#2605" });
  });

  test("an empty href field links nothing but still shows the text", () => {
    expect(linkCell({ value: "x", row: ROW, href: "workUrl", text: "No task" })).toEqual({
      target: null,
      label: "No task",
    });
    expect(linkCell({ value: "", row: ROW, href: "workUrl" })).toEqual({
      target: null,
      label: null,
    });
  });

  test("a non-string URL field is no target", () => {
    expect(linkCell({ value: 1, row: { ...ROW, url: 12 }, href: "url" }).target).toBeNull();
  });

  test("a linkLabel that renders empty falls back to the text, then to a derived label", () => {
    expect(linkCell({ value: ROW.url, row: ROW, linkLabel: "{{missing}}" }).label).toBeNull();
    expect(
      linkCell({ value: ROW.url, row: ROW, linkLabel: "{{missing}}", text: "Fallback" }).label,
    ).toBe("Fallback");
  });

  test("owner/repo#N shorthand passes through as the target", () => {
    expect(linkCell({ value: "desplega-ai/agent-swarm#2605", row: ROW }).target).toBe(
      "desplega-ai/agent-swarm#2605",
    );
  });
});

describe("tipText", () => {
  test("empty for nothing, a trimmed string otherwise", () => {
    expect(tipText(null)).toBe("");
    expect(tipText(undefined)).toBe("");
    expect(tipText("  why  ")).toBe("why");
    expect(tipText(42)).toBe("42");
    expect(tipText({ a: 1 })).toBe('{"a":1}');
  });

  test("long text is cut with an ellipsis", () => {
    const text = tipText("x".repeat(TIP_MAX_CHARS + 50));
    expect(text).toHaveLength(TIP_MAX_CHARS + 1);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("isClipped", () => {
  const box = (scrollWidth: number, clientWidth: number, scrollHeight = 20, clientHeight = 20) => ({
    scrollWidth,
    clientWidth,
    scrollHeight,
    clientHeight,
  });

  test("true when the text is wider or taller than its box", () => {
    expect(isClipped(box(180, 100))).toBe(true);
    expect(isClipped(box(100, 100, 60, 40))).toBe(true);
  });

  test("false when it fits, and for a one-pixel rounding gap", () => {
    expect(isClipped(box(100, 100))).toBe(false);
    expect(isClipped(box(101, 100, 21, 20))).toBe(false);
  });
});

describe("cellHasControls", () => {
  test("link, copy, switch and checkbox cells render their own controls", () => {
    expect(cellHasControls({ kind: "link" })).toBe(true);
    expect(cellHasControls({ kind: "text", href: "url" })).toBe(true);
    expect(cellHasControls({ kind: "copy" })).toBe(true);
    expect(cellHasControls({ kind: "switch" })).toBe(true);
    expect(cellHasControls({ kind: "checkbox" })).toBe(true);
  });

  test("plain kinds do not", () => {
    for (const kind of [undefined, "text", "badge", "status", "date", "number", "progress"]) {
      expect(cellHasControls({ kind })).toBe(false);
    }
  });

  test("a templated column is text unless it links", () => {
    expect(cellHasControls({ kind: "copy", format: "{{a}}" })).toBe(false);
    expect(cellHasControls({ kind: "switch", format: "{{a}}" })).toBe(false);
    expect(cellHasControls({ kind: "checkbox", format: "{{a}}" })).toBe(false);
    expect(cellHasControls({ format: "{{repo}}#{{number}}", href: "url" })).toBe(true);
  });

  test("isLinkColumn is kind link or href", () => {
    expect(isLinkColumn({ kind: "link" })).toBe(true);
    expect(isLinkColumn({ href: "url" })).toBe(true);
    expect(isLinkColumn({ kind: "copy" })).toBe(false);
  });
});

describe("isPhoneControlColumn", () => {
  const onChange = [{ action: "app.mutate" }];

  test("an editable checkbox or switch gets a phone control", () => {
    expect(isPhoneControlColumn({ kind: "checkbox", onChange })).toBe(true);
    expect(isPhoneControlColumn({ kind: "switch", onChange })).toBe(true);
  });

  test("a formatted column stays card text, as on desktop", () => {
    expect(isPhoneControlColumn({ kind: "checkbox", format: "{{name}}", onChange })).toBe(false);
    expect(isPhoneControlColumn({ kind: "switch", format: "{{name}}", onChange })).toBe(false);
  });

  test("a link column stays card text", () => {
    expect(isPhoneControlColumn({ kind: "checkbox", href: "url", onChange })).toBe(false);
  });

  test("a read-only checkbox or another kind gets none", () => {
    expect(isPhoneControlColumn({ kind: "checkbox" })).toBe(false);
    expect(isPhoneControlColumn({ kind: "checkbox", onChange: [] })).toBe(false);
    expect(isPhoneControlColumn({ kind: "text", onChange })).toBe(false);
  });
});
