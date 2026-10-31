import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultRehypePlugins } from "streamdown";

// The root `bun test` does not resolve the UI's `@/` alias. The renderer and
// utils map to the real modules. Monaco, the theme, Comb links and the
// swarm link chips are stubbed: the link hook keeps Streamdown's default
// rehype plugins, the list `MarkdownView` filters.
const SRC = new URL("../../../", import.meta.url).pathname;
for (const alias of ["@/components/shared/markdown-view", "@/lib/utils"]) {
  const path = Bun.resolveSync(`./${alias.slice(2)}`, SRC);
  mock.module(alias, () => require(path));
}
mock.module("@monaco-editor/react", () => ({ default: () => null }));
mock.module("@/hooks/use-theme", () => ({ useTheme: () => ({ theme: "light" }) }));
mock.module("@/hooks/use-comb-links", () => ({ useCombLinks: () => () => null }));
mock.module(Bun.resolveSync("../markdown-link-chip", import.meta.dir), () => ({
  SwarmLinkChip: () => null,
  useSwarmLinkPlugins: () => Object.values(defaultRehypePlugins),
}));

const { MessageText } = await import("./message-text");

describe("MessageText", () => {
  test("shows HTML-like text in a person's message as written", () => {
    const html = renderToStaticMarkup(
      <MessageText text="return Promise<void> and fix the <TaskCard> layout" raw={false} />,
    );
    expect(html).toContain("return Promise&lt;void&gt; and fix the &lt;TaskCard&gt; layout");
  });
});
