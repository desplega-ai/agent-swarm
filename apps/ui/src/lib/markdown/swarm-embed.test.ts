import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Streamdown } from "streamdown";
import {
  COMB_MD_COMPONENTS,
  COMB_REHYPE_PLUGINS,
  COMB_REMARK_PLUGINS,
  CombMarkdown,
} from "../../components/comb/viewers/comb-markdown";
import { embedFromElementProps, matchSwarmEmbed, remarkSwarmEmbed } from "./swarm-embed";
import cases from "./swarm-embed-cases.json";

const ID = "7f1c2a4e-9b3d-4e61-8a0f-5c2d1e3b4a67";
const DOC = { orgId: "org-1", driveId: "drive-1", path: "/notes/readme.md" };

describe("matchSwarmEmbed, shared cases", () => {
  for (const c of cases.matcher) {
    test(`${c.category}: ${c.name}`, () => {
      expect(matchSwarmEmbed(c.html)).toEqual(c.expect as never);
    });
  }

  test("the fixture covers every status", () => {
    const statuses = new Set(cases.matcher.map((c) => (c.expect as { status: string }).status));
    expect([...statuses].sort()).toEqual(["embed", "invalid", "none"]);
  });
});

const decode = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

// The real Comb pipeline (remark, raw, sanitize, components map). Valid
// `swarm-embed` elements print the embed they stand for, so the fixture's
// `embeds` can be compared.
const probe = (props: Record<string, unknown>) => {
  const embed = embedFromElementProps(props);
  return createElement(
    "i",
    {
      "data-probe": JSON.stringify(
        embed.status === "embed" ? { tag: embed.tag, props: embed.props } : null,
      ),
    },
    embed.status === "invalid" ? embed.error : null,
  );
};

function renderPipeline(markdown: string) {
  const markup = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        Streamdown,
        {
          mode: "static",
          parseIncompleteMarkdown: false,
          controls: false,
          remarkPlugins: COMB_REMARK_PLUGINS,
          rehypePlugins: COMB_REHYPE_PLUGINS,
          components: { ...COMB_MD_COMPONENTS, "swarm-embed": probe } as never,
        },
        markdown,
      ),
    ),
  );
  const embeds = Array.from(markup.matchAll(/data-probe="([^"]*)"/g), (m) =>
    JSON.parse(decode(m[1] ?? "")),
  ).filter(Boolean);
  return { markup, embeds, text: decode(markup.replace(/<[^>]+>/g, "")) };
}

describe("swarm embeds in rendered Comb Markdown, shared cases", () => {
  for (const c of cases.documents) {
    test(c.name, () => {
      const { markup, embeds, text } = renderPipeline(c.markdown);
      expect(embeds).toEqual(c.embeds);
      expect(markup).not.toMatch(/<swarm/i);
      for (const visible of c.visibleText) {
        const match = matchSwarmEmbed(visible);
        if (match.status === "invalid") {
          // agent-fs live shows the tag text; the dashboard shows the reason in an error chip.
          expect(text).toContain(match.error);
        } else if (/<(pre|code)\b/.test(markup)) {
          expect(text).toContain(visible);
        }
        // Else the text is a non-embed tag in prose or a cell. agent-fs live shows it as
        // text; Comb runs raw HTML through rehype-raw and sanitize, which drop an unknown
        // element as they do today. Either way it is not an embed (`embeds` above).
      }
    });
  }
});

function renderComb(text: string, props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(CombMarkdown, { text, doc: DOC, ...props })),
  );
}

describe("CombMarkdown with swarm tags", () => {
  // `SwarmEmbedBlockProps` is `ObjectEmbed`'s own prop names, so the host spreads them onto it.
  test("a valid tag renders the embed with the parsed props, and no tag text or element", () => {
    const seen: Record<string, unknown>[] = [];
    const Spy = (props: Record<string, unknown>) => {
      seen.push(props);
      return null;
    };
    const html = renderComb(
      `<SwarmSheet id="${ID}" tab="Q4" range="B2:D9" height="480" readonly="true" />\n\n<SwarmBoard id="${ID}" />\n`,
      { SwarmEmbed: Spy },
    );
    expect(seen).toEqual([
      { objectId: ID, tab: "Q4", range: "B2:D9", height: 480, readOnly: true },
      { objectId: ID },
    ]);
    expect(html).not.toContain("&lt;Swarm");
    expect(html).not.toMatch(/<swarm/i);
  });

  test("an invalid tag is a visible error chip, never an embed", () => {
    let embeds = 0;
    const Spy = () => {
      embeds++;
      return null;
    };
    const html = renderComb(`<SwarmBoard id="${ID}" onload="alert(1)" />\n`, { SwarmEmbed: Spy });
    expect(embeds).toBe(0);
    expect(html).toContain('role="alert"');
    expect(decode(html)).toContain("Invalid SwarmBoard tag: unknown attribute `onload`");
    expect(html).not.toMatch(/<[a-z][^>]*\sonload=/i);
    expect(html).not.toMatch(/<swarm/i);
  });

  test("a hand-written swarm-embed element cannot carry values the grammar refuses", () => {
    let embeds = 0;
    const Spy = () => {
      embeds++;
      return null;
    };
    const html = renderComb(
      [
        '<swarm-embed data-kind="sheet" data-object-id="../x" onload="alert(1)"></swarm-embed>',
        "",
        `<swarm-embed data-kind="board" data-object-id="${ID}" data-tab="x" style="position:fixed"></swarm-embed>`,
        "",
        '<swarm-embed data-kind="sheet" data-object-id="x" data-evil="1"></swarm-embed>',
      ].join("\n"),
      { SwarmEmbed: Spy },
    );
    expect(embeds).toBe(0);
    expect(html).not.toMatch(/<swarm/i);
    expect(html).not.toContain("onload");
    expect(html).not.toContain("position:fixed");
    expect(html).not.toContain("data-evil");
  });

  test("other raw HTML is sanitized as before", () => {
    const html = renderComb(
      '<script>alert(1)</script>\n\n<div onclick="x" class="note">hi</div>\n',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).toContain("hi");
  });

  test("surrounding Markdown renders the same with and without the tag", () => {
    const body = (tag: string) => `# Title\n\nBefore.\n\n${tag}\n\n- one\n- two\n\nAfter.\n`;
    const strip = (html: string) => html.replace('<div data-comb-skip="true"></div>', "");
    const withTag = renderComb(body(`<SwarmSheet id="${ID}" />`), { SwarmEmbed: () => null });
    const without = renderComb(body("<!-- -->"));
    expect(strip(withTag).replace(/data-line-(start|end)="\d+"/g, "")).toBe(
      without.replace(/data-line-(start|end)="\d+"/g, ""),
    );
  });
});

describe("remarkSwarmEmbed", () => {
  type Node = { type: string; value?: string; children?: Node[]; data?: unknown };
  const run = (tree: Node) => (remarkSwarmEmbed() as (tree: Node) => void)(tree);

  test("an invalid tag becomes an error element and drops its text", () => {
    const html: Node = { type: "html", value: `<SwarmSheet id="${ID}" onload="x" />` };
    run({ type: "root", children: [html] });
    expect(html.value).toBeUndefined();
    expect(html.data).toEqual({
      hName: "swarm-embed",
      hProperties: { dataError: "Invalid SwarmSheet tag: unknown attribute `onload`" },
    });
  });

  test("other HTML and inline HTML are left alone", () => {
    const other: Node = { type: "html", value: "<details>x</details>" };
    const inline: Node = { type: "html", value: `<SwarmSheet id="${ID}" />` };
    run({
      type: "root",
      children: [other, { type: "paragraph", children: [inline] }],
    });
    expect(other.type).toBe("html");
    expect(inline.type).toBe("html");
  });
});
