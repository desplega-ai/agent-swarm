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
 */
export async function renderSteeringDelivery(
  steeringMessageId: string,
  body: string,
): Promise<string> {
  try {
    const result = await resolveTemplateAsync("system.agent.steering.delivery", {
      steeringMessageId,
      body,
    });
    return result.skipped || !result.text.trim() ? body : result.text;
  } catch {
    return body;
  }
}
