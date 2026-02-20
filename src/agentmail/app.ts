import { Webhook } from "svix";

let initialized = false;
let webhookSecret: string | null = null;

export function isAgentMailEnabled(): boolean {
  const disabled = process.env.AGENTMAIL_DISABLE;
  if (disabled === "true" || disabled === "1") {
    return false;
  }

  return !!process.env.AGENTMAIL_WEBHOOK_SECRET;
}

export function initAgentMail(): boolean {
  if (initialized) {
    console.log("[AgentMail] Already initialized, skipping");
    return isAgentMailEnabled();
  }
  initialized = true;

  const disabled = process.env.AGENTMAIL_DISABLE;
  if (disabled === "true" || disabled === "1") {
    console.log("[AgentMail] Disabled via AGENTMAIL_DISABLE");
    return false;
  }

  webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET ?? null;

  if (!webhookSecret) {
    console.log("[AgentMail] Missing AGENTMAIL_WEBHOOK_SECRET, AgentMail integration disabled");
    return false;
  }

  console.log("[AgentMail] Webhook handler initialized");
  return true;
}

/**
 * Verify AgentMail webhook signature using Svix
 * Returns the verified payload on success, null on failure
 */
export function verifyAgentMailWebhook(
  rawBody: string,
  headers: Record<string, string>,
): unknown | null {
  if (!webhookSecret) {
    console.log("[AgentMail] Signature verification failed: no webhook secret configured");
    return null;
  }

  try {
    const wh = new Webhook(webhookSecret);
    return wh.verify(rawBody, headers);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[AgentMail] Signature verification failed: ${message}`);
    return null;
  }
}
