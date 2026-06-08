import { describe, expect, test } from "bun:test";
import { extractSlackMessageText } from "../slack/message-text";

describe("extractSlackMessageText", () => {
  test("returns top-level text when present", () => {
    expect(extractSlackMessageText({ text: "hello world" })).toBe("hello world");
  });

  test("returns empty string when all fields are absent", () => {
    expect(extractSlackMessageText({})).toBe("");
  });

  test("returns empty string when text is empty and no attachments/blocks", () => {
    expect(extractSlackMessageText({ text: "" })).toBe("");
    expect(extractSlackMessageText({ text: "   " })).toBe("");
  });

  describe("legacy attachments fallback (Datadog / PagerDuty / GitHub alert shape)", () => {
    test("uses fallback when text is empty", () => {
      const msg = {
        text: "",
        attachments: [{ fallback: "Triggered: [P3] A Bull job process-inscribe-webhook failed" }],
      };
      expect(extractSlackMessageText(msg)).toBe(
        "Triggered: [P3] A Bull job process-inscribe-webhook failed",
      );
    });

    test("uses attachment text when fallback is absent", () => {
      const msg = {
        text: "",
        attachments: [{ text: "Job failed in queue document_fraud_check" }],
      };
      expect(extractSlackMessageText(msg)).toBe("Job failed in queue document_fraud_check");
    });

    test("uses attachment title as tertiary fallback", () => {
      const msg = { text: "", attachments: [{ title: "Alert Title" }] };
      expect(extractSlackMessageText(msg)).toBe("Alert Title");
    });

    test("uses pretext as last attachment fallback", () => {
      const msg = { text: "", attachments: [{ pretext: "Some pretext" }] };
      expect(extractSlackMessageText(msg)).toBe("Some pretext");
    });

    test("joins multiple attachment texts with newline", () => {
      const msg = {
        text: "",
        attachments: [{ fallback: "Alert 1" }, { fallback: "Alert 2" }],
      };
      expect(extractSlackMessageText(msg)).toBe("Alert 1\nAlert 2");
    });

    test("skips empty attachments, uses non-empty ones", () => {
      const msg = {
        text: "",
        attachments: [{}, { fallback: "real content" }, {}],
      };
      expect(extractSlackMessageText(msg)).toBe("real content");
    });

    test("top-level text wins over attachments", () => {
      const msg = { text: "top text", attachments: [{ fallback: "ignored" }] };
      expect(extractSlackMessageText(msg)).toBe("top text");
    });
  });

  describe("Block Kit blocks fallback", () => {
    test("extracts text from a section block", () => {
      const msg = {
        text: "",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Alert*: CPU spike detected" } },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe("*Alert*: CPU spike detected");
    });

    test("extracts text from section.fields when section has no top-level text", () => {
      const msg = {
        text: "",
        blocks: [
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: "*Status:* resolved" },
              { type: "mrkdwn", text: "*Priority:* P2" },
            ],
          },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe("*Status:* resolved\n*Priority:* P2");
    });

    test("extracts text from rich_text block elements", () => {
      const msg = {
        text: "",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "Rich text content" }],
              },
            ],
          },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe("Rich text content");
    });

    test("extracts text from rich_text_list -> rich_text_section -> text (nested list)", () => {
      const msg = {
        text: "",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_list",
                style: "bullet",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: "item one" }],
                  },
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: "item two" }],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe("item one\nitem two");
    });

    test("joins multiple section blocks with newline", () => {
      const msg = {
        text: "",
        blocks: [
          { type: "section", text: { type: "plain_text", text: "Line 1" } },
          { type: "section", text: { type: "plain_text", text: "Line 2" } },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe("Line 1\nLine 2");
    });

    test("attachments take priority over blocks", () => {
      const msg = {
        text: "",
        attachments: [{ fallback: "from attachment" }],
        blocks: [{ type: "section", text: { type: "plain_text", text: "from block" } }],
      };
      expect(extractSlackMessageText(msg)).toBe("from attachment");
    });

    test("returns empty string when blocks have no extractable text", () => {
      const msg = {
        text: "",
        blocks: [{ type: "divider" }, { type: "image" }],
      };
      expect(extractSlackMessageText(msg)).toBe("");
    });
  });

  describe("malformed input — never throws", () => {
    test("blocks: [null] — skips null entry, returns empty string", () => {
      expect(() => extractSlackMessageText({ text: "", blocks: [null] } as any)).not.toThrow();
      expect(extractSlackMessageText({ text: "", blocks: [null] } as any)).toBe("");
    });

    test("attachments: [null] — skips null entry, returns empty string", () => {
      expect(() => extractSlackMessageText({ text: "", attachments: [null] } as any)).not.toThrow();
      expect(extractSlackMessageText({ text: "", attachments: [null] } as any)).toBe("");
    });

    test("attachments: 'oops' (non-array) — returns empty string without throwing", () => {
      expect(() => extractSlackMessageText({ text: "", attachments: "oops" } as any)).not.toThrow();
      expect(extractSlackMessageText({ text: "", attachments: "oops" } as any)).toBe("");
    });

    test("blocks: 'x' (non-array) — returns empty string without throwing", () => {
      expect(() => extractSlackMessageText({ text: "", blocks: "x" } as any)).not.toThrow();
      expect(extractSlackMessageText({ text: "", blocks: "x" } as any)).toBe("");
    });

    test("blocks: [null, { type: 'section', text: { text: 'ok' } }] — skips null, returns valid text", () => {
      const msg = {
        text: "",
        blocks: [null, { type: "section", text: { type: "plain_text", text: "ok" } }],
      } as any;
      expect(() => extractSlackMessageText(msg)).not.toThrow();
      expect(extractSlackMessageText(msg)).toBe("ok");
    });

    test("rich_text block with null element in elements array — skips null inner", () => {
      const msg = {
        text: "",
        blocks: [
          {
            type: "rich_text",
            elements: [
              null,
              { type: "rich_text_section", elements: [{ type: "text", text: "hi" }] },
            ],
          },
        ],
      } as any;
      expect(() => extractSlackMessageText(msg)).not.toThrow();
      expect(extractSlackMessageText(msg)).toBe("hi");
    });

    test("rich_text block where elements is not an array — skips block", () => {
      const msg = {
        text: "",
        blocks: [{ type: "rich_text", elements: "not-an-array" }],
      } as any;
      expect(() => extractSlackMessageText(msg)).not.toThrow();
      expect(extractSlackMessageText(msg)).toBe("");
    });

    test("rich_text inner elements non-array — skips safely", () => {
      const msg = {
        text: "",
        blocks: [
          {
            type: "rich_text",
            elements: [{ type: "rich_text_section", elements: "oops" }],
          },
        ],
      } as any;
      expect(() => extractSlackMessageText(msg)).not.toThrow();
      expect(extractSlackMessageText(msg)).toBe("");
    });

    test("attachments mixed null and valid entries — returns valid text only", () => {
      const msg = {
        text: "",
        attachments: [null, { fallback: "real" }, null],
      } as any;
      expect(() => extractSlackMessageText(msg)).not.toThrow();
      expect(extractSlackMessageText(msg)).toBe("real");
    });
  });
});
