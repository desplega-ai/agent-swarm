/**
 * Type definitions for the Rocket.Chat adapter.
 */

import type { Logger } from "chat";

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for the Rocket.Chat adapter.
 *
 * Every field is optional and falls back to an environment variable, so
 * `createRocketChatAdapter()` works with no arguments when the environment
 * is set.
 */
export interface RocketChatAdapterConfig {
  /**
   * Rocket.Chat server base URL, without a trailing slash or `/api/v1`
   * suffix (e.g. `https://chat.example.com`).
   * Defaults to the `ROCKETCHAT_URL` env var.
   */
  baseUrl?: string;
  /**
   * User ID of the bot account, used for the `X-User-Id` REST header and
   * for ignoring the bot's own messages.
   * Defaults to the `ROCKETCHAT_USER_ID` env var.
   */
  botUserId?: string;
  /** Logger instance for error reporting. Defaults to ConsoleLogger. */
  logger?: Logger;
  /**
   * Personal access token (or login auth token) used for the
   * `X-Auth-Token` REST header.
   * Defaults to the `ROCKETCHAT_TOKEN` env var.
   */
  token?: string;
  /**
   * Bot username used for @-mention detection.
   * Defaults to the `ROCKETCHAT_BOT_USERNAME` env var, then falls back to
   * `"rocketchat-bot"`.
   */
  userName?: string;
  /**
   * Shared secret configured on the Outgoing Webhook integration, compared
   * against the `token` field of each incoming webhook payload.
   * Defaults to the `ROCKETCHAT_WEBHOOK_TOKEN` env var.
   */
  webhookToken?: string;
}

// =============================================================================
// Thread ID
// =============================================================================

/**
 * Decoded thread ID for Rocket.Chat.
 *
 * Thread ID formats:
 * - Room-level: `rocketchat:{roomId}`
 * - Thread reply: `rocketchat:{roomId}:{tmid}`
 */
export interface RocketChatThreadId {
  /** Room (channel, private group, or DM) ID. */
  roomId: string;
  /** Parent message ID of the thread. Omit for the room-level thread. */
  tmid?: string;
}

// =============================================================================
// Rocket.Chat API objects
// =============================================================================

/** Minimal user reference embedded in messages (`u` field). */
export interface RocketChatMessageUser {
  _id: string;
  name?: string;
  username: string;
}

/** Reaction map keyed by emoji shortcode, as returned on a message. */
export type RocketChatReactions = Record<string, { usernames: string[] }>;

/**
 * Message as returned by the REST API (`chat.postMessage`, `chat.update`,
 * `chat.getMessage`, `chat.getThreadMessages`, `channels.history`,
 * `rooms.history`, …).
 */
export interface RocketChatMessage {
  _id: string;
  _updatedAt?: string;
  alias?: string;
  attachments?: Record<string, unknown>[];
  channels?: Record<string, unknown>[];
  editedAt?: string;
  editedBy?: RocketChatMessageUser;
  groupable?: boolean;
  md?: Record<string, unknown>[];
  mentions?: Record<string, unknown>[];
  msg: string;
  reactions?: RocketChatReactions;
  replies?: string[];
  rid: string;
  starred?: Record<string, unknown>[];
  t?: string;
  tcount?: number;
  tlm?: string;
  /** Present when the message is a reply in a thread. */
  tmid?: string;
  ts: string;
  u: RocketChatMessageUser;
  urls?: Record<string, unknown>[];
}

/**
 * User as returned by `users.info` / `users.list`.
 *
 * @see https://developer.rocket.chat/apidocs/user-schema
 */
export interface RocketChatUser {
  _id: string;
  active?: boolean;
  emails?: { address: string; verified: boolean }[];
  name?: string;
  /** `"user"`, `"bot"`, or `"app"`. Absent on older servers. */
  type?: string;
  username: string;
}

// =============================================================================
// Raw message
// =============================================================================

/** Platform-specific raw message stored on every `Message` from Rocket.Chat. */
export interface RocketChatRawMessage {
  /** The message itself, in REST API shape. */
  message: RocketChatMessage;
  /** Room ID the message belongs to. */
  roomId: string;
}

// =============================================================================
// REST API responses
// =============================================================================

/** Response of `POST chat.postMessage`. */
export interface RocketChatPostMessageResponse {
  channel: string;
  message: RocketChatMessage;
  success: boolean;
  ts: number | string;
}

/** Response of `POST chat.update`. */
export interface RocketChatUpdateMessageResponse {
  message: RocketChatMessage;
  success: boolean;
}

/** Response of `POST chat.delete`. */
export interface RocketChatDeleteMessageResponse {
  _id: string;
  message?: Partial<RocketChatMessage>;
  success: boolean;
  ts: string;
}

/** Response of `GET chat.getMessage`. */
export interface RocketChatGetMessageResponse {
  message: RocketChatMessage;
  success: boolean;
}

/** Response of `GET chat.getThreadMessages`. */
export interface RocketChatGetThreadMessagesResponse {
  count: number;
  messages: RocketChatMessage[];
  offset: number;
  success: boolean;
  total: number;
}

/** Response of `GET rooms.history`. */
export interface RocketChatRoomsHistoryResponse {
  cursor?: {
    next: string | null;
    previous: string | null;
  };
  messages: RocketChatMessage[];
  success: boolean;
}

/** Room as returned by `rooms.info`. */
export interface RocketChatRoom {
  _id: string;
  fname?: string;
  name?: string;
  /** Room type: `c` (channel), `p` (private group), `d` (DM), `l` (livechat). */
  t: string;
  topic?: string;
}

/** Response of `GET rooms.info`. */
export interface RocketChatRoomInfoResponse {
  room: RocketChatRoom;
  success: boolean;
}

/** Response of `GET users.info`. */
export interface RocketChatUserInfoResponse {
  success: boolean;
  user: RocketChatUser;
}

/** Error envelope returned by the Rocket.Chat REST API on non-2xx responses. */
export interface RocketChatErrorResponse {
  error?: string;
  errorType?: string;
  success: false;
}

// =============================================================================
// Outgoing webhook payload
// =============================================================================

/**
 * Body posted by a Rocket.Chat Outgoing Webhook integration when a message
 * is sent in a room the integration is attached to.
 *
 * @see https://docs.rocket.chat/docs/outgoing-webhook-integrations
 */
export interface RocketChatWebhookPayload {
  alias?: string;
  /** `true` when the message author is a bot (including this adapter). */
  bot?: boolean;
  channel_id: string;
  channel_name?: string;
  message_id: string;
  siteUrl?: string;
  text: string;
  /** Thread message ID, present when replying inside a thread. */
  tmid?: string;
  timestamp: string;
  /** Shared secret configured on the integration, verified against `webhookToken`. */
  token: string;
  user_id: string;
  user_name: string;
}
