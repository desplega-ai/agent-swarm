import { CardSpecError, standardComponentDefinitions, toCard } from "@json-render/chat";
import type { CardElement } from "chat";
import * as z from "zod";

// No callback buttons yet: nothing handles a click, so `Button` stays out and
// `Actions` holds `LinkButton`s only.
const { Button: _button, ...standard } = standardComponentDefinitions;

/** The components an agent-authored card may use. */
export const chatCardComponents = {
  ...standard,
  Actions: { ...standard.Actions, description: "Row of LinkButton elements." },
};

/** Slack's per-message caps; past them the adapter degrades content, so reject instead. */
export const CARD_LIMITS = { tables: 1, charts: 2 } as const;

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
    `Optional json-render card spec, rendered as a native card. Use it for structured results: key figures, a table, up to ${CARD_LIMITS.charts} charts, links. At most ${CARD_LIMITS.tables} table. ${CARD_RULES} Components: ${catalogLines}`,
  );

export type CardSpecInput = z.infer<typeof cardSpecInputSchema>;

/**
 * Validate an agent's spec and build the Chat SDK card. Returns the
 * `CardSpecError` issues instead of throwing so a tool can hand them back.
 */
export function renderCard(spec: CardSpecInput): { card: CardElement } | { issues: string[] } {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: toCard validates the shape and reports issues
    return { card: toCard(spec as any, { components: chatCardComponents, limits: CARD_LIMITS }) };
  } catch (error) {
    if (error instanceof CardSpecError) return { issues: error.issues };
    throw error;
  }
}

/** Tool error text for a rejected spec: one issue per line, for the agent to fix. */
export function cardIssuesMessage(issues: string[]): string {
  return `Invalid card spec. Fix it and retry:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
}

/** Block Kit and notification text for native Slack. */
export async function cardToSlack(
  card: CardElement,
): Promise<{ blocks: Record<string, unknown>[]; text: string }> {
  // Lazy like the Chat SDK adapters: the adapter module is only loaded when a card is posted.
  const { cardToBlockKit, cardToFallbackText } = await import("@chat-adapter/slack");
  return {
    blocks: cardToBlockKit(card),
    text: cardToFallbackText(card),
  };
}
