import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { sendKapsoText } from "@/integrations/kapso/client";
import { getKapsoConfig } from "@/integrations/kapso/config";
import { createToolRegistrar } from "@/tools/utils";

/** Shared structured-error message for the 24h session-window case. */
const SESSION_WINDOW_HINT =
  'Outside the 24h WhatsApp session window — free-form text is rejected. Use a pre-approved template message (see the `kapso-whatsapp` skill, "Send a template").';

const outputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  messageId: z.string().optional(),
  sessionWindowExpired: z.boolean().optional(),
});

export const registerSendWhatsappMessageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "send-whatsapp-message",
    {
      title: "Send WhatsApp Message",
      annotations: { openWorldHint: true },
      description:
        "Send a free-form WhatsApp text via Kapso (within the 24h session window). Thin wrapper over the Kapso Meta-proxy send. For templates/media/reactions use the `kapso-whatsapp` skill. If the recipient is outside the 24h window the call returns a structured error pointing at the template path.",
      inputSchema: z.object({
        phoneNumberId: z
          .string()
          .min(1)
          .describe("The swarm's Kapso/Meta phone-number ID to send from (KAPSO_PHONE_NUMBER_ID)."),
        to: z
          .string()
          .min(1)
          .describe("Recipient phone in E.164 WITHOUT '+' (e.g. '15551234567')."),
        body: z.string().min(1).describe("Message text."),
        previewUrl: z
          .boolean()
          .optional()
          .describe("Render a link preview for URLs in the body (default false)."),
      }),
      outputSchema,
    },
    async ({ phoneNumberId, to, body, previewUrl }, requestInfo) => {
      return sendAndFormat({ phoneNumberId, to, body, previewUrl }, requestInfo.agentId, undefined);
    },
  );
};

export const registerReplyWhatsappMessageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "reply-whatsapp-message",
    {
      title: "Reply to WhatsApp Message",
      annotations: { openWorldHint: true },
      description:
        "Quote-reply a WhatsApp message via Kapso — same as send-whatsapp-message but threads to a specific inbound WAMID via context.message_id. Recipient is inferred from the conversation; pass the original sender's phone as `to`.",
      inputSchema: z.object({
        phoneNumberId: z
          .string()
          .min(1)
          .describe("The swarm's Kapso/Meta phone-number ID to send from (KAPSO_PHONE_NUMBER_ID)."),
        to: z.string().min(1).describe("Recipient phone in E.164 WITHOUT '+'."),
        inReplyTo: z
          .string()
          .min(1)
          .describe("The inbound WAMID to quote-reply (set as context.message_id)."),
        body: z.string().min(1).describe("Reply text."),
      }),
      outputSchema,
    },
    async ({ phoneNumberId, to, inReplyTo, body }, requestInfo) => {
      return sendAndFormat({ phoneNumberId, to, body }, requestInfo.agentId, inReplyTo);
    },
  );
};

async function sendAndFormat(
  params: { phoneNumberId: string; to: string; body: string; previewUrl?: boolean },
  agentId: string | undefined,
  contextMessageId: string | undefined,
) {
  try {
    const config = getKapsoConfig();
    if (!config.apiKey) {
      const msg = "KAPSO_API_KEY is not configured in swarm config.";
      return {
        content: [{ type: "text" as const, text: msg }],
        structuredContent: { yourAgentId: agentId, success: false, message: msg },
      };
    }

    const result = await sendKapsoText({
      apiBaseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      phoneNumberId: params.phoneNumberId,
      to: params.to,
      body: params.body,
      previewUrl: params.previewUrl,
      contextMessageId,
    });

    if (result.ok) {
      const text = `Sent WhatsApp message to ${params.to} (wamid ${result.messageId ?? "unknown"})`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          yourAgentId: agentId,
          success: true,
          message: text,
          messageId: result.messageId,
        },
      };
    }

    const text = result.sessionWindowExpired
      ? `${SESSION_WINDOW_HINT} (Kapso: ${result.errorMessage})`
      : `Kapso send failed: ${result.errorMessage}`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: {
        yourAgentId: agentId,
        success: false,
        message: text,
        sessionWindowExpired: result.sessionWindowExpired,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${errorMessage}` }],
      structuredContent: { yourAgentId: agentId, success: false, message: errorMessage },
    };
  }
}
