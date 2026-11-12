import { describe, expect, test } from "bun:test";
import {
  composerDocToText,
  composerTextToDoc,
  mentionMarkdown,
  parseMentions,
} from "./composer-mentions";

const AGENT = "/agents/16990304-0000-4000-8000-000000000000";

describe("mention serializer", () => {
  test("a chip is a markdown link to its route", () => {
    expect(mentionMarkdown({ char: "@", label: "Researcher", href: AGENT })).toBe(
      `[@Researcher](${AGENT})`,
    );
    expect(mentionMarkdown({ char: "/", label: "pr-review", href: "/skills/s1" })).toBe(
      "[/pr-review](/skills/s1)",
    );
  });

  test("escapes brackets in the label and wraps an href with spaces", () => {
    const md = mentionMarkdown({ char: "@", label: "Fix [WIP] x", href: "/comb/a b(1).md" });
    expect(md).toBe("[@Fix \\[WIP\\] x](</comb/a b(1).md>)");
    expect(parseMentions(md)).toEqual([
      { char: "@", label: "Fix [WIP] x", href: "/comb/a b(1).md" },
    ]);
  });

  test("parses only @ and / links to root-relative routes", () => {
    expect(parseMentions(`ask [@Researcher](${AGENT}) about [docs](https://x.dev)`)).toEqual([
      "ask ",
      { char: "@", label: "Researcher", href: AGENT },
      " about [docs](https://x.dev)",
    ]);
    expect(parseMentions("[@x](https://evil.dev)")).toEqual(["[@x](https://evil.dev)"]);
  });

  test("text round-trips through the editor doc", () => {
    const text = `line one [@Researcher](${AGENT})\n\nuse [/pr-review](/skills/s1) now`;
    const doc = composerTextToDoc(text);
    expect(doc.content).toHaveLength(3);
    expect(doc.content[1]).toEqual({ type: "paragraph" });
    expect(doc.content[0].content?.[1]).toEqual({
      type: "mention",
      attrs: { id: AGENT, label: "Researcher", mentionSuggestionChar: "@" },
    });
    expect(composerDocToText(doc)).toBe(text);
  });

  test("an empty value is one empty paragraph", () => {
    expect(composerTextToDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(composerDocToText(composerTextToDoc(""))).toBe("");
  });
});
