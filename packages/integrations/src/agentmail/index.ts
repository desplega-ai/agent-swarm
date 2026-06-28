// AgentMail Integration
export { initAgentMail, isAgentMailEnabled, resetAgentMail, verifyAgentMailWebhook } from "./app";
export { handleMessageReceived, isInboxAllowed, isSenderAllowed } from "./handlers";
export type {
  AgentMailAttachment,
  AgentMailEventType,
  AgentMailMessage,
  AgentMailWebhookPayload,
} from "./types";
