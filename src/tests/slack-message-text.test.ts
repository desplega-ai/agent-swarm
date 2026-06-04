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
});
