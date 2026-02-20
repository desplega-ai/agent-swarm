/**
 * AgentMail webhook payload types
 * Based on Svix delivery format used by AgentMail
 */

export interface AgentMailAttachment {
  attachment_id: string;
  filename: string;
  content_type: string;
  size: number;
  inline: boolean;
}

export interface AgentMailMessage {
  message_id: string;
  thread_id: string;
  inbox_id: string;
  organization_id: string;
  from_: string | string[];
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  preview: string;
  text: string | null;
  html: string | null;
  labels: string[];
  attachments: AgentMailAttachment[];
  in_reply_to: string | null;
  references: string[];
  timestamp: string;
  created_at: string;
  updated_at: string;
}

export interface AgentMailWebhookPayload {
  type: "event";
  event_type: AgentMailEventType;
  event_id: string;
  message?: AgentMailMessage;
}

export type AgentMailEventType =
  | "message.received"
  | "message.sent"
  | "message.delivered"
  | "message.bounced"
  | "message.complained"
  | "message.rejected"
  | "domain.verified";
