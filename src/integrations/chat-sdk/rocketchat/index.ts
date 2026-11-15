import { createHash, timingSafeEqual } from "node:crypto";
import {
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Author,
  ChannelInfo,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  ThreadInfo,
  UserInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, defaultEmojiResolver, Message } from "chat";
import { RocketChatFormatConverter } from "./markdown";
import type {
  RocketChatAdapterConfig,
  RocketChatDeleteMessageResponse,
  RocketChatErrorResponse,
  RocketChatGetMessageResponse,
  RocketChatGetThreadMessagesResponse,
  RocketChatMessage,
  RocketChatMessageUser,
  RocketChatPostMessageResponse,
  RocketChatRawMessage,
  RocketChatRoomInfoResponse,
  RocketChatRoomsHistoryResponse,
  RocketChatThreadId,
  RocketChatUpdateMessageResponse,
  RocketChatUserInfoResponse,
  RocketChatWebhookPayload,
} from "./types";

export { RocketChatFormatConverter } from "./markdown";
export type {
  RocketChatAdapterConfig,
  RocketChatMessage,
  RocketChatMessageUser,
  RocketChatRawMessage,
  RocketChatReactions,
  RocketChatRoom,
  RocketChatThreadId,
  RocketChatUser,
  RocketChatWebhookPayload,
} from "./types";

const DEFAULT_USER_NAME = "rocketchat-bot";
const THREAD_ID_PATTERN = /^rocketchat:([^:]+)(?::([^:]+))?$/;
const CHANNEL_ID_PATTERN = /^rocketchat:([^:]+)$/;
const REGEX_SPECIAL_PATTERN = /[.*+?^${}()|[\]\\]/g;
const EMOJI_PLACEHOLDER_REGEX = /\{\{emoji:([a-z0-9_]+)\}\}/gi;

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

/**
 * Rocket.Chat adapter for Chat SDK.
 *
 * Handles messages posted in channels, private groups, and direct messages
 * via a Rocket.Chat Outgoing Webhook integration, and posts replies through
 * the REST API.
 *
 * @example
 * ```typescript
 * import { Chat } from "chat";
 * import { createRocketChatAdapter } from "@/integrations/chat-sdk/rocketchat";
 * import { createMemoryState } from "@chat-adapter/state-memory";
 *
 * const bot = new Chat({
 *   userName: "my-bot",
 *   adapters: { rocketchat: createRocketChatAdapter() },
 *   state: createMemoryState(),
 * });
 * ```
 */
export class RocketChatAdapter implements Adapter<RocketChatThreadId, RocketChatRawMessage> {
  readonly name = "rocketchat";

  protected readonly baseUrl: string;
  protected readonly token: string;
  protected readonly webhookToken: string;
  protected readonly logger: Logger;
  protected readonly formatConverter = new RocketChatFormatConverter();
  protected chat: ChatInstance | null = null;
  protected _botUserId: string;
  protected _userName: string;

  /** Bot username used for @-mention detection. */
  get userName(): string {
    return this._userName;
  }

  /** Bot user ID used for self-message detection and the `X-User-Id` header. */
  get botUserId(): string | undefined {
    return this._botUserId;
  }

  constructor(config: RocketChatAdapterConfig = {}) {
    const baseUrl = config.baseUrl ?? process.env.ROCKETCHAT_URL;
    if (!baseUrl) {
      throw new ValidationError(
        "rocketchat",
        "Server URL is required. Set ROCKETCHAT_URL or provide baseUrl in config.",
      );
    }
    const token = config.token ?? process.env.ROCKETCHAT_TOKEN;
    if (!token) {
      throw new ValidationError(
        "rocketchat",
        "Authentication is required. Set ROCKETCHAT_TOKEN or provide token in config.",
      );
    }
    const botUserId = config.botUserId ?? process.env.ROCKETCHAT_USER_ID;
    if (!botUserId) {
      throw new ValidationError(
        "rocketchat",
        "Bot user ID is required. Set ROCKETCHAT_USER_ID or provide botUserId in config.",
      );
    }
    const webhookToken = config.webhookToken ?? process.env.ROCKETCHAT_WEBHOOK_TOKEN;
    if (!webhookToken) {
      throw new ValidationError(
        "rocketchat",
        "Webhook verification is required. Set ROCKETCHAT_WEBHOOK_TOKEN or provide webhookToken in config.",
      );
    }

    this.baseUrl = trimTrailingSlashes(baseUrl);
    this.token = token;
    this._botUserId = botUserId;
    this.webhookToken = webhookToken;
    this._userName = config.userName ?? process.env.ROCKETCHAT_BOT_USERNAME ?? DEFAULT_USER_NAME;
    this.logger = config.logger ?? new ConsoleLogger("info").child("rocketchat");
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  /**
   * Whether a user is the bot, by comparing user IDs.
   */
  protected isSelf(userId: string): boolean {
    return userId === this._botUserId;
  }

  // ===========================================================================
  // REST API
  // ===========================================================================

  /**
   * Call the Rocket.Chat REST API with the adapter's credentials.
   *
   * `path` is relative to `/api/v1`, for example `/channels.info`. Use this
   * for any Rocket.Chat API call that isn't covered by the Chat SDK surface.
   *
   * @example
   * ```ts
   * const rocketchat = bot.getAdapter("rocketchat");
   * const info = await rocketchat.request("GET", "/channels.info", {
   *   query: { roomId: "GENERAL" },
   * });
   * ```
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      "x-auth-token": this.token,
      "x-user-id": this._botUserId,
      accept: "application/json",
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      // Refuse redirects. `fetch` drops only `Authorization` on a
      // cross-origin redirect, so a followed redirect would carry
      // `x-auth-token` to whatever host the instance points at.
      response = await fetch(url, { method, headers, body, redirect: "error" });
    } catch (error) {
      throw new NetworkError(
        "rocketchat",
        `Rocket.Chat API request failed: ${method} ${path}`,
        error instanceof Error ? error : undefined,
      );
    }

    if (!response.ok) {
      await this.throwApiError(response, method, path);
    }
    return (await response.json()) as T;
  }

  protected async throwApiError(response: Response, method: string, path: string): Promise<never> {
    const detail = await response.text().catch(() => "");
    this.logger.debug("Rocket.Chat API error", {
      method,
      path,
      status: response.status,
      detail,
    });
    const parsed = parseRocketChatErrorMessage(detail);
    switch (response.status) {
      case 401:
        throw new AuthenticationError(
          "rocketchat",
          "Rocket.Chat rejected the credentials. Check that ROCKETCHAT_TOKEN and ROCKETCHAT_USER_ID are valid.",
        );
      case 403:
        throw new PermissionError("rocketchat", `${method} ${path}`, "api");
      case 404:
        throw new ResourceNotFoundError("rocketchat", "resource", path);
      case 429: {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        throw new AdapterRateLimitError(
          "rocketchat",
          Number.isNaN(retryAfter) ? undefined : retryAfter,
        );
      }
      case 400:
        throw new ValidationError("rocketchat", parsed ?? `Invalid request: ${method} ${path}`);
      default:
        throw new NetworkError(
          "rocketchat",
          `Rocket.Chat API error ${response.status}: ${parsed ?? detail}`,
        );
    }
  }

  // ===========================================================================
  // Webhooks
  // ===========================================================================

  /**
   * Handle an incoming request from a Rocket.Chat Outgoing Webhook
   * integration.
   */
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const body = await request.text();

    let payload: RocketChatWebhookPayload | null;
    try {
      payload = JSON.parse(body);
    } catch {
      this.logger.error("Rocket.Chat webhook invalid JSON");
      return new Response("Invalid JSON", { status: 400 });
    }

    if (typeof payload !== "object" || payload === null) {
      return new Response("ok", { status: 200 });
    }

    if (!this.verifyToken(payload.token)) {
      this.logger.debug("Rocket.Chat webhook token verification failed");
      return new Response("Invalid token", { status: 401 });
    }

    if (!this.chat) {
      this.logger.warn("Chat instance not initialized, ignoring message");
      return new Response("ok", { status: 200 });
    }

    if (payload.bot || this.isSelf(payload.user_id)) {
      this.logger.debug("Ignoring message from self", {
        messageId: payload.message_id,
      });
      return new Response("ok", { status: 200 });
    }

    const message = this.buildMessageFromWebhook(payload);
    // `void` marks the fire-and-forget. processMessage catches
    // its own errors and registers the work with `options.waitUntil`.
    void this.chat.processMessage(this, message.threadId, message, options);

    return new Response("ok", { status: 200 });
  }

  /**
   * Verify the webhook's `token` field with a timing-safe comparison.
   */
  protected verifyToken(token: string | undefined): boolean {
    if (!token) {
      return false;
    }
    // Compare fixed-length digests, so a length mismatch does
    // not return early and leak the secret's length.
    const expected = createHash("sha256").update(this.webhookToken).digest();
    const received = createHash("sha256").update(token).digest();
    return timingSafeEqual(expected, received);
  }

  protected buildMessageFromWebhook(
    payload: RocketChatWebhookPayload,
  ): Message<RocketChatRawMessage> {
    const message: RocketChatMessage = {
      _id: payload.message_id,
      msg: payload.text,
      rid: payload.channel_id,
      ts: payload.timestamp,
      u: {
        _id: payload.user_id,
        username: payload.user_name,
      },
      ...(payload.tmid ? { tmid: payload.tmid } : {}),
    };
    return this.buildMessage({ message, roomId: payload.channel_id });
  }

  // ===========================================================================
  // Parsing
  // ===========================================================================

  /**
   * Parse a raw Rocket.Chat message into a normalized Message.
   */
  parseMessage(raw: RocketChatRawMessage): Message<RocketChatRawMessage> {
    return this.buildMessage(raw);
  }

  protected buildMessage(raw: RocketChatRawMessage): Message<RocketChatRawMessage> {
    const { message } = raw;
    const threadId = this.encodeThreadId({
      roomId: raw.roomId,
      ...(message.tmid ? { tmid: message.tmid } : {}),
    });
    const { formatted, text } = this.formatConverter.parseIncoming(message.msg);

    return new Message({
      id: message._id,
      threadId,
      text,
      formatted,
      raw,
      author: this.parseAuthor(message.u),
      isMention: mentionsUser(text, this._userName),
      metadata: {
        dateSent: parseRocketChatDate(message.ts),
        edited: Boolean(message.editedAt),
        ...(message.editedAt ? { editedAt: parseRocketChatDate(message.editedAt) } : {}),
      },
      attachments: [],
    });
  }

  /**
   * Parse a Rocket.Chat message author into an Author.
   */
  protected parseAuthor(user: RocketChatMessageUser): Author {
    return {
      userId: user._id,
      userName: user.username,
      fullName: user.name || user.username,
      isBot: "unknown",
      isMe: this.isSelf(user._id),
    };
  }

  // ===========================================================================
  // Messages
  // ===========================================================================

  /**
   * Render a postable message to a Rocket.Chat-compatible string.
   *
   * Cards, buttons, and modals aren't supported in this version: callers
   * posting a `CardElement` get its fallback text (or a `[Unsupported
   * content]` placeholder) rendered as plain text.
   */
  protected renderBody(message: AdapterPostableMessage): string {
    const body = this.formatConverter.renderPostable(message);
    return convertRocketChatEmojiPlaceholders(body);
  }

  /**
   * Post a message to a room, or reply inside a thread when the thread ID
   * carries a `tmid`.
   */
  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<RocketChatRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    const text = this.renderBody(message);

    const response = await this.request<RocketChatPostMessageResponse>(
      "POST",
      "/chat.postMessage",
      {
        body: {
          roomId: thread.roomId,
          text,
          ...(thread.tmid ? { tmid: thread.tmid } : {}),
        },
      },
    );

    return {
      id: response.message._id,
      threadId,
      raw: { message: response.message, roomId: thread.roomId },
    };
  }

  /**
   * Edit an existing message.
   */
  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<RocketChatRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    const response = await this.request<RocketChatUpdateMessageResponse>("POST", "/chat.update", {
      body: {
        roomId: thread.roomId,
        msgId: messageId,
        text: this.renderBody(message),
      },
    });

    return {
      id: response.message._id,
      threadId,
      raw: { message: response.message, roomId: thread.roomId },
    };
  }

  /**
   * Delete a message.
   */
  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const thread = this.decodeThreadId(threadId);
    await this.request<RocketChatDeleteMessageResponse>("POST", "/chat.delete", {
      body: { roomId: thread.roomId, msgId: messageId },
    });
  }

  /**
   * Add an emoji reaction to a message.
   */
  async addReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.request<{ success: boolean }>("POST", "/chat.react", {
      body: {
        messageId,
        emoji: this.toRocketChatEmoji(emoji),
        shouldReact: true,
      },
    });
  }

  /**
   * Remove the bot's emoji reaction from a message.
   */
  async removeReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.request<{ success: boolean }>("POST", "/chat.react", {
      body: {
        messageId,
        emoji: this.toRocketChatEmoji(emoji),
        shouldReact: false,
      },
    });
  }

  /**
   * Convert an SDK emoji to a Rocket.Chat shortcode (no surrounding colons).
   */
  protected toRocketChatEmoji(emoji: EmojiValue | string): string {
    const name = typeof emoji === "string" ? emoji : emoji.name;
    return defaultEmojiResolver.toSlack(name);
  }

  /**
   * Show typing indicator (no-op). Rocket.Chat's REST API has no endpoint for
   * sending a typing indicator; that's only available over the realtime
   * DDP/WebSocket API, which this adapter doesn't use.
   */
  async startTyping(_threadId: string, _status?: string): Promise<void> {
    // No REST endpoint exists for typing indicators.
  }

  // ===========================================================================
  // Fetching
  // ===========================================================================

  /**
   * Fetch messages in a thread, oldest first.
   *
   * Room-level threads (no `tmid`) use `rooms.history`. Thread-reply threads
   * use `chat.getThreadMessages`.
   */
  async fetchMessages(
    threadId: string,
    options?: FetchOptions,
  ): Promise<FetchResult<RocketChatRawMessage>> {
    const thread = this.decodeThreadId(threadId);
    const limit = options?.limit ?? 50;
    const direction = options?.direction ?? "backward";

    if (thread.tmid) {
      const response = await this.request<RocketChatGetThreadMessagesResponse>(
        "GET",
        "/chat.getThreadMessages",
        {
          query: {
            tmid: thread.tmid,
            count: limit,
            offset:
              options?.cursor && /^\d+$/.test(options.cursor)
                ? Number.parseInt(options.cursor, 10)
                : undefined,
            sort: JSON.stringify({ ts: direction === "backward" ? -1 : 1 }),
          },
        },
      );
      const messages = response.messages
        .map((message) => this.buildMessage({ message, roomId: thread.roomId }))
        .sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime());
      const nextOffset = response.offset + response.count;
      return {
        messages,
        nextCursor: nextOffset < response.total ? String(nextOffset) : undefined,
      };
    }

    const response = await this.request<RocketChatRoomsHistoryResponse>("GET", "/rooms.history", {
      query: {
        roomId: thread.roomId,
        count: limit,
        ...(direction === "backward" ? { previous: options?.cursor } : { next: options?.cursor }),
      },
    });
    // rooms.history returns messages newest first; the SDK expects
    // chronological (oldest first) order within the page.
    const messages = [...response.messages]
      .reverse()
      .map((message) => this.buildMessage({ message, roomId: thread.roomId }));
    const nextCursor =
      direction === "backward"
        ? (response.cursor?.previous ?? undefined)
        : (response.cursor?.next ?? undefined);
    return { messages, nextCursor };
  }

  /**
   * Fetch a single message by ID.
   */
  async fetchMessage(
    threadId: string,
    messageId: string,
  ): Promise<Message<RocketChatRawMessage> | null> {
    const thread = this.decodeThreadId(threadId);
    try {
      const response = await this.request<RocketChatGetMessageResponse>("GET", "/chat.getMessage", {
        query: { msgId: messageId },
      });
      return this.buildMessage({
        message: response.message,
        roomId: thread.roomId,
      });
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch thread (room) metadata.
   */
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const thread = this.decodeThreadId(threadId);
    const response = await this.request<RocketChatRoomInfoResponse>("GET", "/rooms.info", {
      query: { roomId: thread.roomId },
    });
    const { room } = response;

    return {
      id: threadId,
      channelId: `rocketchat:${thread.roomId}`,
      channelName: room.fname ?? room.name,
      isDM: room.t === "d",
      metadata: { roomId: thread.roomId, type: room.t, topic: room.topic },
    };
  }

  /**
   * Fetch Rocket.Chat room info as channel metadata.
   */
  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const roomId = this.decodeChannelId(channelId);
    const response = await this.request<RocketChatRoomInfoResponse>("GET", "/rooms.info", {
      query: { roomId },
    });
    const { room } = response;

    return {
      id: channelId,
      name: room.fname ?? room.name ?? roomId,
      isDM: room.t === "d",
      metadata: { roomId, type: room.t, topic: room.topic },
    };
  }

  /**
   * Render formatted content to Rocket.Chat markdown.
   */
  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  /**
   * Look up a Rocket.Chat user by ID.
   */
  async getUser(userId: string): Promise<UserInfo | null> {
    try {
      const response = await this.request<RocketChatUserInfoResponse>("GET", "/users.info", {
        query: { userId },
      });
      const { user } = response;
      return {
        fullName: user.name || user.username,
        isBot: user.type === "bot" || user.type === "app",
        userId: user._id,
        userName: user.username,
        ...(user.emails?.[0]?.address ? { email: user.emails[0].address } : {}),
      };
    } catch (error) {
      this.logger.debug("Failed to fetch user", { userId, error });
      return null;
    }
  }

  // ===========================================================================
  // Thread IDs
  // ===========================================================================

  /**
   * Encode platform data into a thread ID string.
   *
   * Thread ID formats:
   * - Room-level: `rocketchat:{roomId}`
   * - Thread reply: `rocketchat:{roomId}:{tmid}`
   */
  encodeThreadId(platformData: RocketChatThreadId): string {
    const { roomId, tmid } = platformData;
    return tmid ? `rocketchat:${roomId}:${tmid}` : `rocketchat:${roomId}`;
  }

  /**
   * Decode a thread ID string back to platform data.
   */
  decodeThreadId(threadId: string): RocketChatThreadId {
    const match = threadId.match(THREAD_ID_PATTERN);
    const roomId = match?.[1];
    if (!match || !roomId) {
      throw new ValidationError("rocketchat", `Invalid Rocket.Chat thread ID: ${threadId}`);
    }
    return { roomId, ...(match[2] ? { tmid: match[2] } : {}) };
  }

  /**
   * Derive the channel (room) ID from a thread ID.
   * `rocketchat:{roomId}:{tmid}` -> `rocketchat:{roomId}`
   */
  channelIdFromThreadId(threadId: string): string {
    return `rocketchat:${this.decodeThreadId(threadId).roomId}`;
  }

  protected decodeChannelId(channelId: string): string {
    const roomId = channelId.match(CHANNEL_ID_PATTERN)?.[1];
    if (!roomId) {
      throw new ValidationError("rocketchat", `Invalid Rocket.Chat channel ID: ${channelId}`);
    }
    return roomId;
  }
}

/**
 * Pull a readable message out of a Rocket.Chat error body
 * (`{ success: false, error, errorType? }`).
 */
function parseRocketChatErrorMessage(detail: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const { error } = parsed as RocketChatErrorResponse;
  return typeof error === "string" ? error : undefined;
}

/**
 * Remove trailing slashes from a URL. A loop rather than a `/\/+$/` regex,
 * which backtracks quadratically on long runs of slashes.
 */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * Parse a Rocket.Chat timestamp. The REST API returns ISO 8601; outgoing
 * webhooks send milliseconds since epoch as a string.
 */
function parseRocketChatDate(value: string): Date {
  return /^\d+$/.test(value) ? new Date(Number.parseInt(value, 10)) : new Date(value);
}

/**
 * Whether plain text mentions `@userName`.
 */
function mentionsUser(text: string, userName: string): boolean {
  const pattern = new RegExp(
    `(?<!\\w)@${userName.replace(REGEX_SPECIAL_PATTERN, "\\$&")}(?![\\w-])`,
    "i",
  );
  return pattern.test(text);
}

/**
 * Convert `{{emoji:name}}` placeholders to Rocket.Chat's `:shortcode:` syntax.
 */
function convertRocketChatEmojiPlaceholders(text: string): string {
  return text.replace(EMOJI_PLACEHOLDER_REGEX, (_, emojiName: string) => {
    return `:${defaultEmojiResolver.toSlack(emojiName)}:`;
  });
}

/**
 * Create a new Rocket.Chat adapter instance.
 *
 * @example
 * ```typescript
 * const bot = new Chat({
 *   userName: "my-bot",
 *   adapters: {
 *     rocketchat: createRocketChatAdapter({
 *       baseUrl: process.env.ROCKETCHAT_URL!,
 *       token: process.env.ROCKETCHAT_TOKEN!,
 *       botUserId: process.env.ROCKETCHAT_USER_ID!,
 *       webhookToken: process.env.ROCKETCHAT_WEBHOOK_TOKEN!,
 *     }),
 *   },
 *   state: createMemoryState(),
 * });
 * ```
 */
export function createRocketChatAdapter(config?: RocketChatAdapterConfig): RocketChatAdapter {
  return new RocketChatAdapter(config);
}
