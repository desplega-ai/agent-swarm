import { describe, expect, test } from "bun:test";
import {
  CARD_LIMITS,
  cardIssuesMessage,
  cardSpecInputSchema,
  cardToSlack,
  chatCardComponents,
  renderCard,
} from "../integrations/cards";

const leaf = (type: string, props: Record<string, unknown>) => ({ type, props, children: [] });

const FULL_CARD = {
  root: "card",
  elements: {
    card: {
      type: "Card",
      props: { title: "Deploy report", subtitle: "api v2.8.3" },
      children: ["text", "fields", "table", "chart", "actions"],
    },
    text: leaf("Text", { content: "All checks **passed**." }),
    fields: { type: "Fields", props: {}, children: ["status"] },
    status: leaf("Field", { label: "Status", value: "green" }),
    table: leaf("Table", {
      headers: ["Job", "Result"],
      rows: [
        ["lint", "pass"],
        ["test", "pass"],
      ],
    }),
    chart: leaf("Chart", {
      title: "Deploys per day",
      chart: {
        type: "bar",
        categories: ["Mon", "Tue"],
        series: [{ name: "Deploys", values: [3, 5] }],
      },
    }),
    actions: { type: "Actions", props: {}, children: ["open"] },
    open: leaf("LinkButton", { label: "Open PR", url: "https://example.com/pr/1" }),
  },
};

function chart(title: string) {
  return leaf("Chart", { title, chart: { type: "pie", segments: [{ label: "a", value: 1 }] } });
}

describe("card catalog", () => {
  test("is the standard catalog without the callback Button", () => {
    expect(Object.keys(chatCardComponents)).not.toContain("Button");
    expect(Object.keys(chatCardComponents)).toContain("LinkButton");
    expect(chatCardComponents.Actions.description).not.toContain("Button and");
  });

  test("the input description names every component and the limits", () => {
    const description = cardSpecInputSchema.description ?? "";
    for (const name of Object.keys(chatCardComponents)) expect(description).toContain(`${name}:`);
    expect(description).toContain(`At most ${CARD_LIMITS.tables} table`);
    expect(description).not.toMatch(/(^|\s)Button:/);
  });
});

describe("renderCard", () => {
  test("renders a full card to native Slack blocks and a fallback text", async () => {
    const rendered = renderCard(FULL_CARD);
    if (!("card" in rendered)) throw new Error(rendered.issues.join("; "));
    const slack = await cardToSlack(rendered.card);
    if ("issues" in slack) throw new Error(slack.issues.join("; "));
    expect(slack.blocks.map((block) => block.type)).toEqual([
      "header",
      "context",
      "section",
      "section",
      "data_table",
      "data_visualization",
      "actions",
    ]);
    const button = (slack.blocks.at(-1)!.elements as Record<string, unknown>[])[0]!;
    expect(button.url).toBe("https://example.com/pr/1");
    expect(slack.text).toContain("Deploy report");
    expect(slack.text).toContain("Status: green");
  });

  test("a callback Button is refused as an unknown component", () => {
    const rendered = renderCard({
      root: "card",
      elements: {
        card: { type: "Card", props: {}, children: ["actions"] },
        actions: { type: "Actions", props: {}, children: ["approve"] },
        approve: leaf("Button", { id: "approve", label: "Approve" }),
      },
    });
    expect(rendered).toEqual({ issues: ['approve: unknown component "Button"'] });
  });

  test("Slack's per-message caps reject a second table and a third chart", () => {
    const tables = renderCard({
      root: "card",
      elements: {
        card: { type: "Card", props: {}, children: ["a", "b"] },
        a: leaf("Table", { headers: ["x"], rows: [["1"]] }),
        b: leaf("Table", { headers: ["x"], rows: [["2"]] }),
      },
    });
    expect(tables).toEqual({ issues: ["at most 1 Table per message"] });
    const charts = renderCard({
      root: "card",
      elements: {
        card: { type: "Card", props: {}, children: ["a", "b", "c"] },
        a: chart("one"),
        b: chart("two"),
        c: chart("three"),
      },
    });
    expect(charts).toEqual({ issues: ["at most 2 Chart per message"] });
  });

  test("a table Slack would cut to a code block is refused", () => {
    const table = (rows: number, columns: number) =>
      renderCard({
        root: "card",
        elements: {
          card: { type: "Card", props: {}, children: ["t"] },
          t: leaf("Table", {
            headers: Array.from({ length: columns }, (_, c) => `col ${c}`),
            rows: Array.from({ length: rows }, (_, r) =>
              Array.from({ length: columns }, (_, c) => `${r}-${c}`.padEnd(40, "x")),
            ),
          }),
        },
      });
    expect(table(101, 2)).toEqual({ issues: ["t: at most 101 rows including the header"] });
    expect(table(1, 21)).toEqual({ issues: ["t: at most 20 columns"] });
    expect(table(100, 3)).toEqual({
      issues: ["Table: 12015 characters in its cells, at most 10000"],
    });
    expect("card" in table(100, 2)).toBe(true);
  });

  test("a chart Slack cannot draw natively is refused instead of cut to a code block", async () => {
    const rendered = renderCard({
      root: "card",
      elements: {
        card: { type: "Card", props: {}, children: ["c"] },
        c: leaf("Chart", {
          title: "Dupes",
          chart: {
            type: "bar",
            categories: ["Mon", "Mon"],
            series: [{ name: "Deploys", values: [3, 5] }],
          },
        }),
      },
    });
    if (!("card" in rendered)) throw new Error(rendered.issues.join("; "));
    expect(await cardToSlack(rendered.card)).toEqual({
      issues: ["Chart: Slack cannot render it natively"],
    });
  });

  test("a broken spec returns every issue as tool error text", () => {
    const rendered = renderCard({ root: "missing", elements: {} });
    if (!("issues" in rendered)) throw new Error("expected issues");
    expect(rendered.issues.length).toBeGreaterThan(0);
    const message = cardIssuesMessage(rendered.issues);
    expect(message.startsWith("Invalid card spec.")).toBe(true);
    for (const issue of rendered.issues) expect(message).toContain(`- ${issue}`);
  });
});
