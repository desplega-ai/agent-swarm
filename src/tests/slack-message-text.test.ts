import { describe, expect, test } from "bun:test";
import { extractSlackMessageText, parseSlackTs } from "../slack/message-text";

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
        attachments: [{ fallback: "Triggered: [P3] A Bull job email-dispatch-worker failed" }],
      };
      expect(extractSlackMessageText(msg)).toBe(
        "Triggered: [P3] A Bull job email-dispatch-worker failed",
      );
    });

    test("uses attachment text when fallback is absent", () => {
      const msg = {
        text: "",
        attachments: [{ text: "Job failed in queue email_dispatch_queue" }],
      };
      expect(extractSlackMessageText(msg)).toBe("Job failed in queue email_dispatch_queue");
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

    test("top-level text appears first, attachment content still included", () => {
      const msg = { text: "top text", attachments: [{ fallback: "attachment content" }] };
      expect(extractSlackMessageText(msg)).toBe("top text\nattachment content");
    });

    test("preserves detailed attachment text even when fallback is also present", () => {
      // Slack attachments commonly carry a short `fallback` for notifications and a
      // full `text` body. The old code used `fallback || text`, silently dropping `text`.
      const msg = {
        text: "fallback",
        attachments: [{ fallback: "fallback", text: "detailed attachment body" }],
      };
      const result = extractSlackMessageText(msg);
      expect(result).toContain("detailed attachment body");
      // "fallback" appears exactly once (either from top-level or attachment — not both)
      expect(result.split("fallback").length - 1).toBe(1);
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

    test("attachments appear before blocks when both present", () => {
      const msg = {
        text: "",
        attachments: [{ fallback: "from attachment" }],
        blocks: [{ type: "section", text: { type: "plain_text", text: "from block" } }],
      };
      expect(extractSlackMessageText(msg)).toBe("from attachment\nfrom block");
    });

    test("returns empty string when blocks have no extractable text", () => {
      const msg = {
        text: "",
        blocks: [{ type: "divider" }, { type: "image" }],
      };
      expect(extractSlackMessageText(msg)).toBe("");
    });
  });

  describe("all layers combined — Datadog/alert-app shapes", () => {
    test("Datadog-style: fallback text + section fields + actions button URL all captured", () => {
      const msg = {
        text: "Triggered: [P2] PaymentsService | [production] API failure with 500",
        blocks: [
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: "*PoC:* @oncall" },
              { type: "mrkdwn", text: "*Error rate:* 1.0/0.0" },
              { type: "mrkdwn", text: "*Tags:* env:production, http.status_code:500" },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Check traces" },
                url: "https://app.datadoghq.com/apm/traces?query=service:payments-service",
              },
            ],
          },
        ],
      };
      const result = extractSlackMessageText(msg);
      expect(result).toContain("Triggered: [P2] PaymentsService");
      expect(result).toContain("*PoC:* @oncall");
      expect(result).toContain("*Error rate:* 1.0/0.0");
      expect(result).toContain("*Tags:* env:production");
      expect(result).toContain("https://app.datadoghq.com/apm/traces");
      expect(result).toContain("Check traces");
    });

    test("short top-level text not dropped when it appears as substring inside block text", () => {
      // "hi" is a substring of "this has unrelated substring" but not a complete line —
      // the old bodyText.includes(topText) check would silently drop it.
      const msg = {
        text: "hi",
        blocks: [
          { type: "section", text: { type: "plain_text", text: "this has unrelated substring" } },
        ],
      };
      const result = extractSlackMessageText(msg);
      expect(result).toContain("hi");
      expect(result).toContain("this has unrelated substring");
    });

    test("top-level text deduped when verbatim present in blocks body", () => {
      const msg = {
        text: "Alert fired",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "Alert fired\nDetails here" } }],
      };
      const result = extractSlackMessageText(msg);
      // "Alert fired" should NOT appear twice
      expect(result.split("Alert fired").length - 1).toBe(1);
      expect(result).toContain("Details here");
    });

    test("context block elements are captured", () => {
      const msg = {
        text: "",
        blocks: [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: "Environment: *production*" },
              { type: "plain_text", text: "Service: payments-service" },
            ],
          },
        ],
      };
      const result = extractSlackMessageText(msg);
      expect(result).toContain("Environment: *production*");
      expect(result).toContain("Service: payments-service");
    });

    test("header block text is captured", () => {
      const msg = {
        text: "",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "New alert triggered" } },
          { type: "section", text: { type: "mrkdwn", text: "Details below" } },
        ],
      };
      const result = extractSlackMessageText(msg);
      expect(result).toContain("New alert triggered");
      expect(result).toContain("Details below");
    });

    test("actions block button without url emits label only", () => {
      const msg = {
        text: "",
        blocks: [
          {
            type: "actions",
            elements: [{ type: "button", text: { type: "plain_text", text: "Dismiss" } }],
          },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe("Dismiss");
    });

    test("actions block button without label emits url only", () => {
      const msg = {
        text: "",
        blocks: [
          {
            type: "actions",
            elements: [{ type: "button", url: "https://example.com/resolve" }],
          },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe("https://example.com/resolve");
    });
  });

  describe("legacy attachment extras — fields and action URLs", () => {
    test("attachment fields (title/value pairs) are captured", () => {
      const msg = {
        text: "",
        attachments: [
          {
            fields: [
              { title: "Priority", value: "P2" },
              { title: "Service", value: "payments-service" },
            ],
          },
        ],
      };
      const result = extractSlackMessageText(msg);
      expect(result).toContain("Priority: P2");
      expect(result).toContain("Service: payments-service");
    });

    test("attachment title_link emitted as mrkdwn link", () => {
      const msg = {
        text: "",
        attachments: [{ title: "View alert", title_link: "https://app.datadoghq.com/event/1" }],
      };
      expect(extractSlackMessageText(msg)).toBe("<https://app.datadoghq.com/event/1|View alert>");
    });

    test("attachment actions[].url emitted as mrkdwn link with label", () => {
      const msg = {
        text: "",
        attachments: [
          {
            fallback: "Alert",
            actions: [{ text: "Resolve", url: "https://pagerduty.com/resolve/123" }],
          },
        ],
      };
      const result = extractSlackMessageText(msg);
      expect(result).toContain("Alert");
      expect(result).toContain("<https://pagerduty.com/resolve/123|Resolve>");
    });

    test("attachment actions[].url without text emits bare URL", () => {
      const msg = {
        text: "",
        attachments: [{ actions: [{ url: "https://example.com/ack" }] }],
      };
      expect(extractSlackMessageText(msg)).toBe("https://example.com/ack");
    });

    test("attachment field with only title emits title", () => {
      const msg = {
        text: "",
        attachments: [{ fields: [{ title: "OnCall" }] }],
      };
      expect(extractSlackMessageText(msg)).toBe("OnCall");
    });

    test("attachment field with only value emits value", () => {
      const msg = {
        text: "",
        attachments: [{ fields: [{ value: "jane.doe" }] }],
      };
      expect(extractSlackMessageText(msg)).toBe("jane.doe");
    });
  });

  describe("regression — plain messages unaffected", () => {
    test("plain text-only message still returns just that text", () => {
      expect(extractSlackMessageText({ text: "hello world" })).toBe("hello world");
    });

    test("empty message still returns empty string", () => {
      expect(extractSlackMessageText({})).toBe("");
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

describe("parseSlackTs", () => {
  test("passes the dotted API form through unchanged", () => {
    expect(parseSlackTs("1783411554.596189")).toBe("1783411554.596189");
  });

  test("converts the 'p' deep-link form back to dotted", () => {
    expect(parseSlackTs("p1783411554596189")).toBe("1783411554.596189");
  });

  test("converts a bare digit run back to dotted", () => {
    expect(parseSlackTs("1783411554596189")).toBe("1783411554.596189");
  });

  test("extracts the ts from a full permalink URL", () => {
    expect(
      parseSlackTs("https://example.slack.com/archives/C0123456789/p1783411554596189"),
    ).toBe("1783411554.596189");
  });

  test("extracts the ts from a permalink URL with a thread_ts query param", () => {
    expect(
      parseSlackTs(
        "https://example.slack.com/archives/C0123456789/p1783411554596189?thread_ts=1783411000.000100&cid=C0123456789",
      ),
    ).toBe("1783411554.596189");
  });

  test("trims surrounding whitespace before parsing", () => {
    expect(parseSlackTs("  1783411554.596189  ")).toBe("1783411554.596189");
  });

  test("falls through unchanged for unrecognized input", () => {
    expect(parseSlackTs("not-a-ts")).toBe("not-a-ts");
  });
});
