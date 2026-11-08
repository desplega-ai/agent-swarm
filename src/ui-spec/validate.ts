import { cardToBlockKit, cardToFallbackText } from "@chat-adapter/slack";
import { CardSpecError, toCard } from "@json-render/chat";
import {
  type TaskUiSpecAction,
  type TaskUiSpecDocument,
  type TaskUiSpecInput,
  UI_SPEC_ACTION_ID,
  UI_SPEC_ACTION_PREFIX,
  UI_SPEC_CARD_LIMITS,
  UI_SPEC_MAX_ACTIONS_ROW_ELEMENTS,
  UI_SPEC_MAX_BLOCKS,
  UI_SPEC_MAX_BYTES,
} from "../utils/task-ui-spec";

export interface ValidateTaskUiSpecOptions {
  taskId: string;
  actionsEnabled: boolean;
}

export type ValidateTaskUiSpecResult =
  | {
      ok: true;
      spec: TaskUiSpecDocument;
      actions: Record<string, TaskUiSpecAction> | undefined;
      blocks: unknown[];
      fallbackText: string;
    }
  | { ok: false; issues: string[] };

export type RenderTaskUiSpecResult =
  | { ok: true; blocks: unknown[]; fallbackText: string }
  | { ok: false; issues: string[] };

/** Element props whose value must be an https: URL, by component type. */
const URL_PROPS: Record<string, string> = {
  LinkButton: "url",
  Image: "url",
  Card: "imageUrl",
};

type Element = { type?: unknown; props?: Record<string, unknown> };

function asElement(value: unknown): Element | null {
  return value !== null && typeof value === "object" ? (value as Element) : null;
}

function elementProps(element: Element): Record<string, unknown> {
  const props = element.props;
  return props !== null && typeof props === "object" ? props : {};
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Steps 4 to 6 of the uiSpec contract: make the render copy, convert it with
 * `toCard`, and check the Slack block budget. Also returns the fallback text.
 */
export function renderTaskUiSpec(spec: TaskUiSpecDocument, taskId: string): RenderTaskUiSpecResult {
  // Step 4: the render copy namespaces Button ids and carries the task id.
  // The stored spec keeps the original ids.
  const renderCopy = structuredClone(spec);
  for (const value of Object.values(renderCopy.elements)) {
    const element = asElement(value);
    if (!element || element.type !== "Button") continue;
    const props = elementProps(element);
    element.props = { ...props, id: `${UI_SPEC_ACTION_PREFIX}${String(props.id)}`, value: taskId };
  }

  // Step 5: convert to a Chat SDK card under the engine limits.
  let card: ReturnType<typeof toCard>;
  try {
    card = toCard(renderCopy as Parameters<typeof toCard>[0], { limits: UI_SPEC_CARD_LIMITS });
  } catch (error) {
    if (error instanceof CardSpecError) return { ok: false, issues: [...error.issues] };
    throw error;
  }

  // Step 6: the Slack block budget.
  const blocks = cardToBlockKit(card);
  const issues: string[] = [];
  if (blocks.length > UI_SPEC_MAX_BLOCKS) {
    issues.push(
      `uiSpec renders as ${blocks.length} Slack blocks; the limit is ${UI_SPEC_MAX_BLOCKS}.`,
    );
  }
  for (const block of blocks as Array<{ type?: string; elements?: unknown[] }>) {
    const count = block.elements?.length ?? 0;
    if (block.type === "actions" && count > UI_SPEC_MAX_ACTIONS_ROW_ELEMENTS) {
      issues.push(
        `An Actions row renders ${count} Slack elements; the limit is ${UI_SPEC_MAX_ACTIONS_ROW_ELEMENTS}.`,
      );
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  // Step 7: the text for surfaces that cannot render the card.
  return { ok: true, blocks, fallbackText: cardToFallbackText(card) };
}

/**
 * Validates an agent-sent uiSpec against the json-render chat catalog and the
 * engine limits. Pure: no I/O. Returns every issue found in steps 1 to 3, or
 * the issues of the first failing later step.
 */
export function validateTaskUiSpec(
  input: TaskUiSpecInput,
  { taskId, actionsEnabled }: ValidateTaskUiSpecOptions,
): ValidateTaskUiSpecResult {
  const issues: string[] = [];

  // Step 1: size.
  const bytes = new TextEncoder().encode(JSON.stringify(input.spec)).length;
  if (bytes > UI_SPEC_MAX_BYTES) {
    issues.push(`uiSpec is ${bytes} bytes; the limit is ${UI_SPEC_MAX_BYTES}.`);
  }

  for (const [elementId, value] of Object.entries(input.spec.elements)) {
    const element = asElement(value);
    if (!element) continue;
    const props = elementProps(element);
    const type = typeof element.type === "string" ? element.type : "";

    // Step 2: URL schemes.
    const urlProp = Object.hasOwn(URL_PROPS, type) ? URL_PROPS[type] : undefined;
    if (urlProp) {
      const url = props[urlProp];
      if (url !== undefined && url !== null && !isHttpsUrl(url)) {
        issues.push(`${elementId}.${urlProp} must be an https: URL.`);
      }
    }

    // Step 3: Buttons need the action flag and a declared action.
    if (type === "Button") {
      if (!actionsEnabled) {
        issues.push(`Button ${elementId} needs UI_SPEC_ACTIONS_ENABLED=true; use LinkButton.`);
        continue;
      }
      const id = props.id;
      const declared =
        typeof id === "string" &&
        UI_SPEC_ACTION_ID.test(id) &&
        input.actions !== undefined &&
        Object.hasOwn(input.actions, id);
      if (!declared) {
        issues.push(
          `Button ${elementId} names action "${String(id)}", which uiSpec.actions does not declare.`,
        );
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const rendered = renderTaskUiSpec(input.spec, taskId);
  if (!rendered.ok) return rendered;
  return {
    ok: true,
    spec: input.spec,
    actions: input.actions,
    blocks: rendered.blocks,
    fallbackText: rendered.fallbackText,
  };
}
