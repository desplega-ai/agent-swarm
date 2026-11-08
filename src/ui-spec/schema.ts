import * as z from "zod";
import { UI_SPEC_ACTION_ID } from "../utils/task-ui-spec";

/** One declared card action, as an agent or a script sends it. */
export const TaskUiSpecActionInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("follow_up"), prompt: z.string().min(1).max(4000) }),
  z.object({
    kind: z.literal("script"),
    script: z.string().min(1).max(200).describe("A global script named in UI_SPEC_SCRIPT_ACTIONS."),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Frozen script input, at most 4 KB of JSON. A click sends no input."),
  }),
]);

/**
 * The uiSpec an agent sends on store-progress, and the result a `script`
 * action returns. Both paths share this schema.
 */
export const TaskUiSpecInputSchema = z.object({
  spec: z
    .object({
      root: z.string().min(1),
      elements: z.record(z.string(), z.unknown()),
      state: z.record(z.string(), z.unknown()).optional(),
    })
    .describe("A json-render spec for the chat catalog. Root must be a Card."),
  actions: z
    .record(z.string().regex(UI_SPEC_ACTION_ID), TaskUiSpecActionInputSchema)
    .optional()
    .describe(
      "Actions that Button ids name. Needs UI_SPEC_ACTIONS_ENABLED=true. A `script` action also needs its script pinned in UI_SPEC_SCRIPT_ACTIONS.",
    ),
});
