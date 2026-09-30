import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { CombMarkdown, type DriveImageProps } from "./comb-markdown";

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

  test("links that escape the drive route render inert, with no href", () => {
    const escapes = render(
      "[a](%2e%2e/%2e%2e/%2e%2e/%2e%2e/settings) [b](.%2e/x.md) [c](..%2F..%2Fx) [d](?q=1)",
    );
    expect(escapes).not.toContain("href=");
    expect(escapes).toContain("<span>a</span>");
    expect(escapes).toContain("<span>c</span>");
  });

  test("sanitize still drops script URLs and script tags", () => {
    const unsafe = render(
      '[x](javascript:alert(1))\n\n<script>alert(2)</script>\n\n<a href="javascript:alert(3)">y</a>',
    );
    expect(unsafe).not.toContain("javascript:");
    expect(unsafe).not.toContain("<script");
  });

  test("sanitize drops iframes, on* handlers, and data: links", () => {
    const unsafe = render(
      [
        '<iframe src="https://evil.example/frame"></iframe>',
        "",
        '<a href="https://example.com" onclick="alert(1)" onmouseover="alert(2)">x</a>',
        "",
        '<img src="https://example.com/a.png" onerror="alert(3)">',
        "",
        "[d](data:text/html;base64,PHNjcmlwdD5hbGVydCg0KTwvc2NyaXB0Pg==)",
        "",
        '<a href="data:text/html,hi">e</a>',
      ].join("\n"),
    );
    expect(unsafe).not.toContain("<iframe");
    expect(unsafe).not.toContain("evil.example");
    expect(unsafe.toLowerCase()).not.toMatch(/\son[a-z]+=/);
    expect(unsafe).not.toContain("data:");
    expect(unsafe).toContain('href="https://example.com"');
  });

  test("sanitize drops <style> with its CSS text", () => {
    const styled = render("<style>body { display: none; }</style>\n\nAfter the style.");
    expect(styled).not.toContain("<style");
    expect(styled).not.toContain("display: none");
    expect(styled).toContain("After the style.");
  });

  test("web images load, drive images show a placeholder that links to the file", () => {
    const images = render(
      "![Chart](https://example.com/chart.png)\n\n![Diagram](./img/diagram.png)",
    );
    expect(images).toContain('src="https://example.com/chart.png"');
    expect(images).toContain('alt="Chart"');
    expect(images).not.toMatch(/<img[^>]*diagram/);
    const placeholder = openingTag(images, "span", "Diagram");
    expect(placeholder).toContain("data-comb-skip");
    expect(images).toContain('href="/file/~/org-1/drive-1/notes/img/diagram.png"');
  });

  test("drive images render through DriveImage, unresolvable ones keep the placeholder", () => {
    const StubImage = ({ file, alt }: DriveImageProps) => (
      <img data-stub={`${file.orgId}/${file.driveId}${file.path}`} alt={alt} />
    );
    const images = renderToStaticMarkup(
      <MemoryRouter>
        <CombMarkdown
          text={[
            "![Pic](./pic.png)",
            "",
            "![Up](../up.png?x=1)",
            "",
            "![Esc](%2e%2e/%2e%2e/secret.png)",
            "",
            "![Dir](./img/)",
          ].join("\n")}
          doc={DOC}
          DriveImage={StubImage}
        />
      </MemoryRouter>,
    );
    expect(images).toContain('data-stub="org-1/drive-1/notes/pic.png" alt="Pic"');
    expect(images).toContain('data-stub="org-1/drive-1/up.png" alt="Up"');
    // The escaping src and the folder src keep the placeholder, never the stub.
    expect(images.match(/data-stub=/g)).toHaveLength(2);
    expect(images.match(/data-comb-skip/g)).toHaveLength(2);
    expect(images).toContain('<span class="truncate">Esc</span>');
    expect(openingTag(images, "span", "Dir")).toContain("data-comb-skip");
  });

  test("a leading YAML block renders as markdown with the file's own lines", () => {
    const withYaml = render("---\ntitle: Notes\n---\n\nBody text.");
    expect(withYaml).toMatch(/<hr[^>]*data-line-start="1"/);
    const heading = openingTag(withYaml, "h2", "title: Notes");
    expect(heading).toContain('data-line-start="2"');
    expect(heading).toContain('data-line-end="3"');
    expect(openingTag(withYaml, "p", "Body text.")).toContain('data-line-start="5"');
  });

  test("inline code keeps the chip style", () => {
    const inline = render("Use `bun test` here.");
    expect(inline).toContain('<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">');
  });
});
