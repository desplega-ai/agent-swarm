// The codex hook is a standalone CLI entry point, so it does not load the
// base-prompt module that normally registers these code-default templates.
import "./session-templates.ts";
import type { SteeringAttachment } from "../types.ts";
import { steeringAttachmentsSection } from "../utils/task-attachment-links.ts";
import { resolveTemplateAsync } from "./resolver.ts";

/**
 * Wrap a steering body in the registered delivery envelope so the injected
 * message carries its own ID. `accept-steer` takes that ID, and it is the only
 * route to `handled` — without the envelope the agent obeys the message but
 * can never acknowledge it, and the row sits at `delivered` forever.
 *
 * Falls back to the bare body if template resolution fails: delivering an
 * un-acknowledgeable message beats not delivering one at all.
 *
 * Shared by the runner's dispatch poll (in-process `deliverSteering`
 * providers) and the codex-hook (harness-side delivery via hook
 * `additionalContext`).
 *
 * Attached files go into the body as one fetch command each, so a custom
 * template that only prints `{{body}}` still hands them to the agent.
 */
export async function renderSteeringDelivery(
  steeringMessageId: string,
  messageBody: string,
  sender = "Unknown sender",
  attachments?: readonly SteeringAttachment[],
): Promise<string> {
  const body = messageBody + steeringAttachmentsSection(attachments);
  try {
    const result = await resolveTemplateAsync("system.agent.steering.delivery", {
      steeringMessageId,
      body,
      sender: sender.replace(/\s+/g, " ").trim(),
    });
    return result.skipped || !result.text.trim() ? body : result.text;
  } catch {
    return body;
  }
}
