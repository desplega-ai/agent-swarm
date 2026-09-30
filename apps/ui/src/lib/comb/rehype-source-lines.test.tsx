import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CombMarkdown } from "../../components/comb/viewers/comb-markdown";

const DOC = { orgId: "org-1", driveId: "drive-1", path: "/notes/readme.md" };

// Line numbers are 1-based and document-absolute.
const SOURCE = [
  "# Title", // 1
  "", // 2
  "```ts", // 3
  "const a = 1;", // 4
  "```", // 5
  "", // 6
  "After the fence.", // 7
  "", // 8
  "- first item", // 9
  "- second item", // 10
  "", // 11
  "| a | b |", // 12
  "| - | - |", // 13
  "| 1 | 2 |", // 14
  "", // 15
  '<div class="note">Raw HTML block</div>', // 16
  "", // 17
  "After the HTML.", // 18
  "", // 19
  "See [other](./other.md) and [site](https://example.com).", // 20
].join("\n");

function render(text: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CombMarkdown text={text} doc={DOC} />
    </MemoryRouter>,
  );
}

/** The opening tag of the first `<tag ...>` whose text follows it. */
function openingTag(html: string, tag: string, text: string): string {
  const at = html.indexOf(text);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf(`<${tag}`, at);
  expect(open).toBeGreaterThan(-1);
  return html.slice(open, html.indexOf(">", open) + 1);
}

describe("Comb markdown source lines", () => {
  const html = render(SOURCE);

  test("a heading at line 1", () => {
    const tag = openingTag(html, "h1", "Title");
    expect(tag).toContain('data-line-start="1"');
    expect(tag).toContain('data-line-end="1"');
  });

  test("a paragraph after a fenced code block", () => {
    const tag = openingTag(html, "p", "After the fence.");
    expect(tag).toContain('data-line-start="7"');
    expect(tag).toContain('data-line-end="7"');
  });

  test("list items", () => {
    expect(openingTag(html, "li", "first item")).toContain('data-line-start="9"');
    expect(openingTag(html, "li", "second item")).toContain('data-line-start="10"');
  });

  test("a table", () => {
    const tag = openingTag(html, "table", "<thead");
    expect(tag).toContain('data-line-start="12"');
    expect(tag).toContain('data-line-end="14"');
  });

  test("a paragraph after a raw HTML block", () => {
    expect(html).toContain("Raw HTML block");
    const tag = openingTag(html, "p", "After the HTML.");
    expect(tag).toContain('data-line-start="18"');
    expect(tag).toContain('data-line-end="18"');
  });

  test("fenced code is a plain pre/code text block, not Monaco", () => {
    const tag = openingTag(html, "pre", "const a = 1;");
    expect(tag).toContain('data-line-start="3"');
    expect(tag).toContain('data-line-end="5"');
    expect(html).toMatch(/<pre[^>]*><code[^>]*>const a = 1;\n?<\/code><\/pre>/);
    expect(html).not.toContain("monaco");
    expect(html).not.toContain('data-streamdown="code-block"');
  });

  test("a relative link opens in Comb, an absolute link opens a new tab", () => {
    expect(html).toContain('href="/file/~/org-1/drive-1/notes/other.md"');
    expect(openingTag(html, "a", "other")).not.toContain("target=");
    expect(openingTag(html, "a", "site")).toContain('target="_blank"');
  });

  test("bare and parent-relative links resolve against the file", () => {
    const links = render("[a](sibling.md) [b](../x/c.md) [c](/top.md)");
    expect(links).toContain('href="/file/~/org-1/drive-1/notes/sibling.md"');
    expect(links).toContain('href="/file/~/org-1/drive-1/x/c.md"');
    expect(links).toContain('href="/file/~/org-1/drive-1/top.md"');
    expect(links).not.toContain("[blocked]");
  });

  test("sanitize still drops script URLs and script tags", () => {
    const unsafe = render(
      '[x](javascript:alert(1))\n\n<script>alert(2)</script>\n\n<a href="javascript:alert(3)">y</a>',
    );
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).not.toContain("<script");
  });

  test("inline code keeps the chip style", () => {
    const inline = render("Use `bun test` here.");
    expect(inline).toContain('<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">');
  });
});
