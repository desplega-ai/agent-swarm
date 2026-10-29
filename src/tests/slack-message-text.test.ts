import { describe, expect, test } from "bun:test";
import {
  collectSlackMessageFiles,
  extractSlackMessageText,
  parseSlackTs,
  slackInboundMessageText,
} from "../slack/message-text";

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

    // Shape of a real multi-line human message: Slack sends mrkdwn `text` and a
    // rich_text block with one element per styled run, mention and link.
    const multiLineHumanMessage = {
      text: "<@U0A1B2C3D> can you check the deploy?\n*It failed* twice &amp; the logs say:\n• timeout on <https://ci.example.com/run/42|run 42>\n• retry :fire:",
      blocks: [
        {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [
                { type: "user", user_id: "U0A1B2C3D" },
                { type: "text", text: " can you check the deploy?\n" },
                { type: "text", text: "It failed", style: { bold: true } },
                { type: "text", text: " twice & the logs say:\n" },
              ],
            },
            {
              type: "rich_text_list",
              style: "bullet",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "text", text: "timeout on " },
                    { type: "link", url: "https://ci.example.com/run/42", text: "run 42" },
                  ],
                },
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "text", text: "retry " },
                    { type: "emoji", name: "fire" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    test("multi-line rich_text human message renders once, as the top-level text", () => {
      const result = extractSlackMessageText(multiLineHumanMessage);
      expect(result).toBe(multiLineHumanMessage.text);
      expect(result.split("can you check the deploy?").length - 1).toBe(1);
    });

    test("single-line rich_text with a mention renders once and keeps the mention", () => {
      const msg = {
        text: "hey <@U0A1B2C3D> ship it",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "hey " },
                  { type: "user", user_id: "U0A1B2C3D" },
                  { type: "text", text: " ship it" },
                ],
              },
            ],
          },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe("hey <@U0A1B2C3D> ship it");
    });

    test("negative control: rich_text that differs from top-level text keeps both", () => {
      const msg = {
        text: "Deploy summary",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "text", text: "Deploy failed on step 3\nRolled back to v1.2" }],
              },
            ],
          },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe(
        "Deploy summary\nDeploy failed on step 3\nRolled back to v1.2",
      );
    });

    test("negative control: rich_text dedupe leaves non-rich_text blocks in place", () => {
      const msg = {
        ...multiLineHumanMessage,
        blocks: [
          ...multiLineHumanMessage.blocks,
          { type: "context", elements: [{ type: "mrkdwn", text: "Sent from CI bot" }] },
        ],
      };
      expect(extractSlackMessageText(msg)).toBe(`${multiLineHumanMessage.text}\nSent from CI bot`);
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

// Shape read from a table our own bot posted (raw_text cells).
const RAW_TEXT_TABLE = {
  type: "table",
  block_id: "qhVnC",
  rows: [
    [
      { type: "raw_text", text: "ID" },
      { type: "raw_text", text: "Owner" },
    ],
    [
      { type: "raw_text", text: "74df2fbd" },
      { type: "raw_text", text: "Local" },
    ],
  ],
  column_settings: [{ align: "left" }, { align: "left", is_wrapped: true }],
};

const richCell = (...elements: unknown[]) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements }],
});

describe("extractSlackMessageText: table blocks", () => {
  test("renders raw_text cells as a markdown table, header first", () => {
    expect(extractSlackMessageText({ text: "", blocks: [RAW_TEXT_TABLE] })).toBe(
      "| ID | Owner |\n| --- | --- |\n| 74df2fbd | Local |",
    );
  });

  test("renders rich_text cells, keeping links, mentions and emoji", () => {
    const table = {
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "Case" },
          { type: "raw_text", text: "Slug" },
        ],
        [
          richCell(
            { type: "text", text: "Acme", style: { bold: true } },
            { type: "text", text: " Corp" },
          ),
          richCell({ type: "link", url: "https://ex.com/casos-de-exito/acme", text: "acme" }),
        ],
        [
          richCell({ type: "user", user_id: "U123" }, { type: "emoji", name: "tada" }),
          richCell({ type: "link", url: "https://ex.com/a" }),
        ],
        [
          { type: "raw_number", value: 42, text: "42" },
          { type: "raw_number", value: 7 },
        ],
      ],
    };
    expect(extractSlackMessageText({ blocks: [table] })).toBe(
      [
        "| Case | Slug |",
        "| --- | --- |",
        "| Acme Corp | [acme](https://ex.com/casos-de-exito/acme) |",
        "| <@U123>:tada: | https://ex.com/a |",
        "| 42 | 7 |",
      ].join("\n"),
    );
  });

  test("escapes pipes and folds newlines so each row stays one line", () => {
    const table = {
      type: "table",
      rows: [[{ type: "raw_text", text: "a|b" }], [{ type: "raw_text", text: "line1\nline2" }]],
    };
    expect(extractSlackMessageText({ blocks: [table] })).toBe(
      "| a\\|b |\n| --- |\n| line1 line2 |",
    );
  });

  test("keeps the table after preceding text when rich_text dedupes against msg.text", () => {
    // A pasted table: msg.text stops at the colon, the rows live only in the table block.
    const lead = "te paso también los slug definitivos que usarás:";
    const table = {
      type: "table",
      rows: [
        [
          { type: "raw_text", text: "Acme" },
          { type: "raw_text", text: "/casos-de-exito/acme" },
        ],
        [
          { type: "raw_text", text: "Globex" },
          { type: "raw_text", text: "/casos-de-exito/globex" },
        ],
      ],
    };
    const msg = {
      text: lead,
      blocks: [
        { type: "rich_text", elements: [richCell({ type: "text", text: lead }).elements[0]] },
        table,
      ],
    };
    expect(extractSlackMessageText(msg)).toBe(
      `${lead}\n| Acme | /casos-de-exito/acme |\n| --- | --- |\n| Globex | /casos-de-exito/globex |`,
    );
  });

  test("keeps block order: text, table, text", () => {
    const msg = {
      text: "",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "before" } },
        RAW_TEXT_TABLE,
        { type: "section", text: { type: "mrkdwn", text: "after" } },
      ],
    };
    expect(extractSlackMessageText(msg)).toBe(
      "before\n| ID | Owner |\n| --- | --- |\n| 74df2fbd | Local |\nafter",
    );
  });

  test("a table is never deduped away against msg.text", () => {
    expect(
      extractSlackMessageText({ text: "ID Owner 74df2fbd Local", blocks: [RAW_TEXT_TABLE] }),
    ).toBe("ID Owner 74df2fbd Local\n| ID | Owner |\n| --- | --- |\n| 74df2fbd | Local |");
  });

  test("renders a data_table block with its caption", () => {
    const table = { type: "data_table", caption: "Teams", rows: RAW_TEXT_TABLE.rows };
    expect(extractSlackMessageText({ blocks: [table] })).toBe(
      "Teams\n| ID | Owner |\n| --- | --- |\n| 74df2fbd | Local |",
    );
  });

  test("pads a header narrower than its rows to the widest row", () => {
    const cell = (text: string) => ({ type: "raw_text", text });
    const table = { type: "table", rows: [[cell("H")], [cell("A"), cell("B")]] };
    expect(extractSlackMessageText({ blocks: [table] })).toBe("| H |  |\n| --- | --- |\n| A | B |");
  });

  test("pads an empty header row to the widest row", () => {
    const cell = (text: string) => ({ type: "raw_text", text });
    const table = { type: "table", rows: [[], [cell("A"), cell("B")]] };
    expect(extractSlackMessageText({ blocks: [table] })).toBe("|  |  |\n| --- | --- |\n| A | B |");
  });

  test("skips a table with no cell text", () => {
    const table = { type: "table", rows: [[{ type: "raw_text", text: "" }]] };
    expect(extractSlackMessageText({ text: "hi", blocks: [table] })).toBe("hi");
  });
});

describe("slackInboundMessageText", () => {
  test("returns msg.text unchanged when there is no table", () => {
    const msg = {
      text: "hello <@U1>",
      blocks: [
        { type: "rich_text", elements: [richCell({ type: "text", text: "hello " }).elements[0]] },
      ],
      attachments: [{ text: "unfurl" }],
    };
    expect(slackInboundMessageText(msg)).toBe("hello <@U1>");
    expect(slackInboundMessageText({})).toBe("");
  });

  test("adds the table rows msg.text leaves out", () => {
    const msg = {
      text: "slugs:",
      blocks: [
        { type: "rich_text", elements: [richCell({ type: "text", text: "slugs:" }).elements[0]] },
        RAW_TEXT_TABLE,
      ],
    };
    expect(slackInboundMessageText(msg)).toBe(
      "slugs:\n| ID | Owner |\n| --- | --- |\n| 74df2fbd | Local |",
    );
  });
});

describe("collectSlackMessageFiles", () => {
  test("returns files of a shared message when top-level files is null", () => {
    // Shape of a message shared into a DM: the screenshot lives on the attachment.
    const msg = {
      files: null,
      attachments: [
        { is_share: true, is_msg_unfurl: true, files: [{ id: "F0CCTPG9A21", name: "image.png" }] },
      ],
    };
    expect(collectSlackMessageFiles(msg).map((f) => f.id)).toEqual(["F0CCTPG9A21"]);
  });

  test("merges top-level and attachment files, deduped by id, top-level first", () => {
    const msg = {
      files: [{ id: "F1" }, { id: "F2" }],
      attachments: [
        { files: [{ id: "F2" }, { id: "F3" }] },
        { text: "no files" },
        { files: [{ id: "F3" }] },
      ],
    };
    expect(collectSlackMessageFiles(msg).map((f) => f.id)).toEqual(["F1", "F2", "F3"]);
  });

  test("returns an empty list for a message without files", () => {
    expect(collectSlackMessageFiles({})).toEqual([]);
    expect(
      collectSlackMessageFiles({ attachments: [{ files: [null, { name: "no id" }] }] }),
    ).toEqual([]);
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
    expect(parseSlackTs("https://example.slack.com/archives/C0123456789/p1783411554596189")).toBe(
      "1783411554.596189",
    );
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
