import { describe, expect, test } from "bun:test";
import { extractMentions, extractText } from "../jira/adf";

describe("jira/adf — extractText", () => {
  test("returns empty string for non-node input", () => {
    expect(extractText(null)).toBe("");
    expect(extractText(undefined)).toBe("");
    expect(extractText("not a node")).toBe("");
    expect(extractText(42)).toBe("");
  });

  test("extracts plain text from a single paragraph", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world." }],
        },
      ],
    };
    expect(extractText(adf)).toBe("Hello world.");
  });

  test("joins text across multiple paragraphs with newlines", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First." }] },
        { type: "paragraph", content: [{ type: "text", text: "Second." }] },
      ],
    };
    expect(extractText(adf)).toBe("First.\nSecond.");
  });

  test("inlines mentions as @<displayName>", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi " },
            {
              type: "mention",
              attrs: { id: "557058:abc-123", text: "@Bot User" },
            },
            { type: "text", text: " please look." },
          ],
        },
      ],
    };
    // mention text "@Bot User" already has "@", normalizer keeps single "@"
    expect(extractText(adf)).toBe("Hi @Bot User please look.");
  });

  test("falls back to accountId when mention has no display text", () => {
    const adf = {
      type: "paragraph",
      content: [
        { type: "text", text: "ping " },
        { type: "mention", attrs: { id: "557058:xyz" } },
      ],
    };
    expect(extractText(adf)).toBe("ping @557058:xyz");
  });

  test("handles bullet and ordered lists", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "alpha" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "beta" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = extractText(adf);
    expect(out).toContain("- alpha");
    expect(out).toContain("- beta");

    // An ordered list numbers its items; `attrs.order` sets the first number.
    const ordered = (attrs?: Record<string, unknown>) => ({
      type: "doc",
      content: [
        {
          type: "orderedList",
          ...(attrs ? { attrs } : {}),
          content: ["first", "second"].map((text) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })),
        },
      ],
    });
    expect(extractText(ordered())).toBe("1. first\n2. second");
    expect(extractText(ordered({ order: 3 }))).toBe("3. first\n4. second");
    expect(extractText(ordered({ order: 0 }))).toBe("0. first\n1. second");
  });

  test("handles headings, codeBlock, blockquote, hardBreak and link cards", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "line1" },
            { type: "hardBreak" },
            { type: "text", text: "line2" },
          ],
        },
        {
          type: "codeBlock",
          content: [{ type: "text", text: "echo hi" }],
        },
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "quoted" }],
            },
          ],
        },
      ],
    };
    const out = extractText(adf);
    expect(out).toContain("Title");
    expect(out).toContain("line1\nline2");
    expect(out).toContain("echo hi");
    expect(out).toContain("quoted");

    // Cards carry their link in attrs.url and have no content to walk, so the
    // walker used to drop them. Block and embed cards end their own line like a
    // paragraph; an inline card joins the line of text around it.
    const cards = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Links: " },
            { type: "inlineCard", attrs: { url: "https://wiki.example/pages/123" } },
          ],
        },
        { type: "blockCard", attrs: { url: "https://github.com/acme/repo/pull/1" } },
        { type: "embedCard", attrs: { url: "https://embed.example/2" } },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    };
    expect(extractText(cards)).toBe(
      "Links: https://wiki.example/pages/123\nhttps://github.com/acme/repo/pull/1\nhttps://embed.example/2\nafter",
    );
  });

  test("descends into unknown node content rather than dropping it", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "weird-custom-type",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "still visible" }],
            },
          ],
        },
      ],
    };
    expect(extractText(adf)).toContain("still visible");
  });
});

describe("jira/adf — extractMentions", () => {
  test("returns empty array for non-node input", () => {
    expect(extractMentions(null)).toEqual([]);
    expect(extractMentions("string")).toEqual([]);
  });

  test("returns empty array when no mentions present", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "no mentions here" }],
        },
      ],
    };
    expect(extractMentions(adf)).toEqual([]);
  });

  test("collects accountIds from all mention nodes", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "557058:a", text: "@Alice" } },
            { type: "text", text: " and " },
            { type: "mention", attrs: { id: "557058:b", text: "@Bob" } },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "557058:c", text: "@Carol" } }],
        },
      ],
    };
    expect(extractMentions(adf)).toEqual(["557058:a", "557058:b", "557058:c"]);
  });

  test("ignores mention nodes without a string id", () => {
    const adf = {
      type: "paragraph",
      content: [
        { type: "mention", attrs: { id: 123 } }, // wrong type
        { type: "mention", attrs: {} }, // missing
        { type: "mention", attrs: { id: "557058:ok", text: "@OK" } },
      ],
    };
    expect(extractMentions(adf)).toEqual(["557058:ok"]);
  });

  test("descends into nested structures (lists, blockquotes)", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "mention",
                      attrs: { id: "557058:nested", text: "@N" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractMentions(adf)).toEqual(["557058:nested"]);
  });
});
