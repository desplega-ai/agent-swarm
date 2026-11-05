import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultRehypePlugins } from "streamdown";

// Same stubs as `transcript/message-text.test.tsx`: the root `bun test` does
// not resolve the UI's `@/` alias, and Monaco does not render on the server.
const SRC = new URL("../../", import.meta.url).pathname;
mock.module("@/lib/utils", () => require(Bun.resolveSync("./lib/utils", SRC)));
mock.module("@monaco-editor/react", () => ({ default: () => null }));
mock.module("@/hooks/use-theme", () => ({ useTheme: () => ({ theme: "light" }) }));
mock.module("@/hooks/use-comb-links", () => ({ useCombLinks: () => () => null }));
mock.module(Bun.resolveSync("./markdown-link-chip", import.meta.dir), () => ({
  SwarmLinkChip: () => null,
  useSwarmLinkPlugins: () => Object.values(defaultRehypePlugins),
}));

const { MarkdownView } = await import("./markdown-view");

describe("MarkdownView", () => {
  test("renders a fence without a language as a code block, not inline code", () => {
    const html = renderToStaticMarkup(<MarkdownView text={"```\nplain fence\n```"} />);
    expect(html).toContain('data-monaco-block="markdown-view"');
    expect(html).not.toContain('data-streamdown="inline-code"');
  });

  test("renders inline code as the shared inline-code chip", () => {
    const html = renderToStaticMarkup(<MarkdownView text="run `bun test` now" />);
    expect(html).toContain('<code data-streamdown="inline-code">bun test</code>');
    expect(html).not.toContain("data-monaco-block");
  });

  test("gives links the shared markdown link class", () => {
    const html = renderToStaticMarkup(<MarkdownView text="see [docs](https://example.com)" />);
    expect(html).toContain('class="md-link"');
  });
});
