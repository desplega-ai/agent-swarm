import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A DOM for client renders; removed after this file so other files keep their
// server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let theme: "dark" | "light" = "dark";
mock.module("@/hooks/use-theme", () => ({ useTheme: () => ({ theme }) }));
mock.module("@/lib/utils", () => require("../../../lib/utils"));
mock.module("@/components/ui/alert-callout", () => require("../../ui/alert-callout"));
mock.module("@/lib/comb/code-language", () => require("../../../lib/comb/code-language"));
mock.module("@/lib/comb/text-lines", () => require("../../../lib/comb/text-lines"));
// `TextViewer` loads bytes through `TextGate`. These tests render `TextLines` only.
mock.module("./text-gate", () => ({ TextGate: () => null }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { TextLines } = await import("./text-viewer");
const { HIGHLIGHT_MAX_CHARS } = await import("../../../lib/comb/code-language");
const { anchorFromRange, buildDomTextSpace } = await import("../../../lib/comb/dom-text-space");
const { resolveAnchor } = await import("../../../lib/comb/comment-anchor");
const { prismTheme } = await import("./code-tokens");

/** The theme's `keyword` color as the DOM reports it (a later theme entry wins). */
function keywordColor(mode: "dark" | "light"): string {
  const color = prismTheme(mode)
    .styles.filter((entry) => !entry.languages && entry.types.includes("keyword"))
    .reduce((found, entry) => entry.style.color ?? found, "");
  const probe = document.createElement("span");
  probe.style.color = color;
  return probe.style.color;
}

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const SOURCE = [
  'import { z } from "zod";',
  "",
  "// One batch holds up to 50 comments.",
  "export const Batch = z.object({",
  "  commentIds: z.array(z.string()).min(1).max(50),",
  "});",
  "",
].join("\n");

async function mountLines(text: string, language: string | null) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TextLines text={text} language={language} />);
  });
  return {
    container,
    rerender: (next: string) =>
      act(async () => {
        root.render(<TextLines text={next} language={language} />);
      }),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Colored token spans inside the rows (the gutter's width style excluded). */
const tokenSpans = (el: Element) =>
  el.querySelectorAll("[data-comb-row] > span:last-child span[style]");

describe("TextLines with syntax highlighting", () => {
  test("the first paint is the plain rows: Prism runs in a background render", () => {
    const html = renderToStaticMarkup(<TextLines text={SOURCE} language="ts" />);
    expect(html).toContain("data-comb-row");
    expect(html).not.toContain('<span style="color:');
  });

  test("highlighted rows: one row per line, token spans, and the file's own text", async () => {
    const view = await mountLines(SOURCE, "ts");
    const rows = view.container.querySelectorAll("[data-comb-row]");
    expect(rows).toHaveLength(6);
    expect(tokenSpans(view.container).length).toBeGreaterThan(10);
    // Blank line 2 holds no text (the empty-line marker renders nothing).
    expect(rows[1].querySelector("span:last-child")?.textContent).toBe("");
    expect(buildDomTextSpace(view.container).text).toBe(SOURCE);
    await view.unmount();
  });

  test("a comment anchored on the plain rows paints the same passage once highlighted", async () => {
    const plain = await mountLines(SOURCE, null);
    const space = buildDomTextSpace(plain.container);
    const exact = "z.array(z.string()).min(1)";
    const at = space.text.indexOf(exact);
    const created = anchorFromRange(space, space.toRange(at, at + exact.length) as Range);
    expect(created?.quote?.exact).toBe(exact);
    expect([created?.lineStart, created?.lineEnd]).toEqual([5, 5]);
    await plain.unmount();

    const highlighted = await mountLines(SOURCE, "ts");
    const tokens = buildDomTextSpace(highlighted.container);
    const resolved = resolveAnchor(tokens, {
      quote: created?.quote,
      lineStart: created?.lineStart,
      lineEnd: created?.lineEnd,
    });
    expect([resolved.status, resolved.start, resolved.end]).toEqual([
      "anchored",
      at,
      at + exact.length,
    ]);
    const range = tokens.toRange(at, at + exact.length);
    expect(range?.toString()).toBe(exact);
    // The range starts and ends inside different token nodes.
    expect(range?.startContainer).not.toBe(range?.endContainer);
    await highlighted.unmount();
  });

  test("the theme picks the token colors (vsDark in dark, github in light)", async () => {
    const constColor = (container: Element) =>
      (tokenSpans(container)[0] as HTMLElement | undefined)?.style.color;
    expect(keywordColor("dark")).not.toBe(keywordColor("light"));
    theme = "dark";
    const dark = await mountLines("const a = 1;", "ts");
    expect(constColor(dark.container)).toBe(keywordColor("dark"));
    await dark.unmount();
    theme = "light";
    const light = await mountLines("const a = 1;", "ts");
    expect(constColor(light.container)).toBe(keywordColor("light"));
    await light.unmount();
    theme = "dark";
  });

  test("text over the cap stays plain, with a notice outside the document text", async () => {
    const line = "const value = 1;\n";
    const big = line.repeat(Math.ceil((HIGHLIGHT_MAX_CHARS + 1) / line.length));
    const view = await mountLines(big, "ts");
    expect(tokenSpans(view.container)).toHaveLength(0);
    expect(view.container.textContent).toContain(
      "Syntax highlighting is off for files over 128 KiB.",
    );
    expect(buildDomTextSpace(view.container).text).toBe(big);
    await view.unmount();
  });

  test("no language: plain rows", async () => {
    const view = await mountLines(SOURCE, null);
    expect(tokenSpans(view.container)).toHaveLength(0);
    expect(buildDomTextSpace(view.container).text).toBe(SOURCE);
    await view.unmount();
  });

  test("a new version re-highlights in place", async () => {
    const view = await mountLines("const a = 1;\n", "ts");
    await view.rerender("let b = 2;\nlet c = 3;\n");
    expect(view.container.querySelectorAll("[data-comb-row]")).toHaveLength(2);
    expect(tokenSpans(view.container).length).toBeGreaterThan(0);
    expect(buildDomTextSpace(view.container).text).toBe("let b = 2;\nlet c = 3;\n");
    await view.unmount();
  });
});
