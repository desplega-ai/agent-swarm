import { CardSpecError, standardComponentDefinitions, toCard } from "@json-render/chat";
import type { CardChild, CardElement } from "chat";
import * as z from "zod";

// No callback buttons yet: nothing handles a click, so `Button` stays out and
// `Actions` holds `LinkButton`s only.
const { Button: _button, ...standard } = standardComponentDefinitions;

/** The components an agent-authored card may use. */
export const chatCardComponents = {
  ...standard,
  Actions: { ...standard.Actions, description: "Row of LinkButton elements." },
};

/**
 * Slack's caps. Past them the adapter turns a table or chart into a code block
 * cut at 3,000 characters, which drops content while the post succeeds, so
 * reject instead. `tableRows` counts the header row.
 */
export const CARD_LIMITS = {
  tables: 1,
  charts: 2,
  fields: 10,
  tableRows: 101,
  tableColumns: 20,
  chartTitle: 50,
  chartLabel: 20,
  chartSeries: 12,
  chartPoints: 20,
} as const;

/** Slack's data_table cap on the characters of all cells, header included. */
export const TABLE_MAX_CELL_CHARS = 10_000;

// One line per component: its description and an example of its props, which
// is the only place the agent sees prop names (Chart and Table need them).
const catalogLines = Object.entries(chatCardComponents)
  .map(([name, def]) => `${name}: ${def.description} Props e.g. ${JSON.stringify(def.example)}.`)
  .join(" ");

const CARD_RULES =
  'Every element has "children" (leaves use []). Field goes inside Fields, LinkButton inside Actions. A bar, line or area Chart has one value per category per series; a pie Chart uses {"type":"pie","segments":[{"label","value"}]}.';

/** Tool input for a json-render chat card spec. `toCard` does the real validation. */
export const cardSpecInputSchema = z
  .looseObject({
    root: z.string().min(1).describe("Id of the root element. It must be a Card."),
    elements: z
      .record(z.string(), z.unknown())
      .describe(
        'Map of element id to { type, props, children: [ids] }. Example: {"root":"c","elements":{"c":{"type":"Card","props":{"title":"Deploy"},"children":["f"]},"f":{"type":"Fields","props":{},"children":["f1"]},"f1":{"type":"Field","props":{"label":"Status","value":"green"},"children":[]}}}',
      ),
  })
  .describe(
    `Optional json-render card spec, rendered as a native card. Use it for structured results: key figures, a table, up to ${CARD_LIMITS.charts} charts, links. At most ${CARD_LIMITS.tables} table, of up to ${CARD_LIMITS.tableRows - 1} rows, ${CARD_LIMITS.tableColumns} columns and ${TABLE_MAX_CELL_CHARS} characters in all. ${CARD_RULES} Components: ${catalogLines}`,
  );

export type CardSpecInput = z.infer<typeof cardSpecInputSchema>;

/**
 * Validate an agent's spec and build the Chat SDK card. Returns the
 * `CardSpecError` issues instead of throwing so a tool can hand them back.
 */
export function renderCard(spec: CardSpecInput): { card: CardElement } | { issues: string[] } {
  let card: CardElement;
  try {
    // biome-ignore lint/suspicious/noExplicitAny: toCard validates the shape and reports issues
    card = toCard(spec as any, { components: chatCardComponents, limits: CARD_LIMITS });
  } catch (error) {
    if (error instanceof CardSpecError) return { issues: error.issues };
    throw error;
  }
  // toCard has no character limit, so check the expanded tables here.
  const issues = cardChildren(card)
    .filter((child) => child.type === "table")
    .flatMap((table) => {
      const chars = [table.headers, ...table.rows]
        .flat()
        .reduce((sum, cell) => sum + cell.length, 0);
      return chars > TABLE_MAX_CELL_CHARS
        ? [`Table: ${chars} characters in its cells, at most ${TABLE_MAX_CELL_CHARS}`]
        : [];
    });
  return issues.length ? { issues } : { card };
}

/** Every child of the card, sections flattened. */
function cardChildren(card: { children: CardChild[] }): CardChild[] {
  return card.children.flatMap((child) =>
    child.type === "section" ? [child, ...cardChildren(child)] : [child],
  );
}

/** Tool error text for a rejected spec: one issue per line, for the agent to fix. */
export function cardIssuesMessage(issues: string[]): string {
  return `Invalid card spec. Fix it and retry:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
}

const NATIVE_SLACK_BLOCKS: Record<string, string[]> = {
  table: ["table", "data_table"],
  chart: ["data_visualization"],
};

/**
 * Block Kit and the card's notification text for native Slack. Returns issues when a table or chart would not render natively: the
 * adapter's code-block fallback is cut at 3,000 characters, so a post could
 * succeed with rows missing. `CARD_LIMITS` stops the known cases first; this
 * catches the rest (a duplicate chart label, a long axis label).
 */
export async function cardToSlack(
  card: CardElement,
): Promise<{ blocks: Record<string, unknown>[]; text: string } | { issues: string[] }> {
  // Lazy like the Chat SDK adapters: the adapter module is only loaded when a card is posted.
  const { cardToBlockKit, cardToFallbackText } = await import("@chat-adapter/slack");
  const issues = cardChildren(card).flatMap((child) => {
    const native = NATIVE_SLACK_BLOCKS[child.type];
    if (!native) return [];
    const [block] = cardToBlockKit({ type: "card", children: [child] });
    return block && native.includes(String(block.type))
      ? []
      : [`${child.type === "table" ? "Table" : "Chart"}: Slack cannot render it natively`];
  });
  if (issues.length) return { issues };
  return {
    blocks: cardToBlockKit(card),
    text: cardToFallbackText(card),
  };
}

/**
 * `renderCard` plus the native check for the adapter the card goes to. The Chat
 * SDK tools call this before they send anything: on Slack the adapter turns a
 * table or chart it cannot draw into a fallback cut at 3,000 characters.
 */
export async function renderCardFor(
  adapter: string,
  spec: CardSpecInput,
): Promise<{ card: CardElement } | { issues: string[] }> {
  const rendered = renderCard(spec);
  if ("issues" in rendered || adapter !== "slack") return rendered;
  const slack = await cardToSlack(rendered.card);
  return "issues" in slack ? slack : rendered;
}

/**
 * Notification text for a message posted with a card: both, message first, so
 * notifications and screen readers do not lose the message.
 */
export function slackFallbackText(message: string, cardText?: string): string {
  return [message, cardText].filter(Boolean).join("\n\n");
}
