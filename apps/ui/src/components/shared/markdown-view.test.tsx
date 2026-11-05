import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultRehypePlugins } from "streamdown";

// Same stubs as `transcript/message-text.test.tsx`: the root `bun test` does
// not resolve the UI's `@/` alias, and Monaco does not render on the server.
const SRC = new URL("../../", import.meta.url).pathname;
mock.module("@/lib/utils", () => require(Bun.resolveSync("./lib/utils", SRC)));
mock.module("@/lib/monaco-themes", () => require(Bun.resolveSync("./lib/monaco-themes", SRC)));
// Monaco does not render on the server: the stub records each editor's props
// so a test can replay how the real editors would mount.
type EditorProps = { theme: string; beforeMount?: (monaco: unknown) => void };
const mountedEditors: EditorProps[] = [];
mock.module("@monaco-editor/react", () => ({
  default: (props: EditorProps) => {
    mountedEditors.push(props);
    return null;
  },
}));
let currentTheme: "light" | "dark" = "light";
mock.module("@/hooks/use-theme", () => ({ useTheme: () => ({ theme: currentTheme }) }));
mock.module("@/hooks/use-comb-links", () => ({ useCombLinks: () => () => null }));
mock.module(Bun.resolveSync("./markdown-link-chip", import.meta.dir), () => ({
  SwarmLinkChip: () => null,
  useSwarmLinkPlugins: () => Object.values(defaultRehypePlugins),
}));

const { MarkdownView } = await import("./markdown-view");
const { ScriptSourceEditor } = await import("../scripts/script-source-editor");

// Monaco keeps ONE theme for the whole page: `defineTheme` registers a name,
// and every editor that mounts calls `setTheme` with its `theme` prop, which
// repaints every other editor too. Replay that for editors mounted in order
// and return the colors every editor ends up painted with.
function mountTogether(editors: EditorProps[]) {
  const themes = new Map<string, { colors: Record<string, string> }>();
  let active = "vs";
  const monaco = {
    editor: {
      defineTheme: (name: string, data: { colors: Record<string, string> }) =>
        themes.set(name, data),
    },
  };
  for (const editor of editors) {
    editor.beforeMount?.(monaco);
    active = editor.theme;
  }
  return { requested: editors.map((e) => e.theme), colors: themes.get(active)?.colors };
}

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

  // A workflow page shows a script node's editor next to markdown snippets.
  // The snippet must not pick its own global theme (a transparent one turned
  // the script editor see-through, and mount order decided who won); it gets
  // its transparent card from CSS scoped to the snippet instead.
  for (const theme of ["light", "dark"] as const) {
    test(`a ${theme} snippet and a script editor share one opaque Monaco theme in either mount order`, () => {
      currentTheme = theme;
      mountedEditors.length = 0;
      renderToStaticMarkup(<ScriptSourceEditor source="export default 1" />);
      const [script] = mountedEditors.splice(0);
      const snippetHtml = renderToStaticMarkup(<MarkdownView text={"```ts\nconst a = 1;\n```"} />);
      const [snippet] = mountedEditors.splice(0);
      expect(script).toBeDefined();
      expect(snippet).toBeDefined();

      for (const order of [
        [script, snippet],
        [snippet, script],
      ]) {
        const { requested, colors } = mountTogether(order);
        expect(new Set(requested).size).toBe(1);
        expect(colors?.["editor.background"]).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(snippetHtml).toContain("data-monaco-snippet");
    });
  }

  test("snippets clear the editor background in CSS, scoped to the snippet", async () => {
    const css = await Bun.file(new URL("../../styles/markdown.css", import.meta.url)).text();
    const rule = /\[data-monaco-snippet\]\s+\.monaco-editor\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toContain("--vscode-editor-background: transparent");
  });
});
