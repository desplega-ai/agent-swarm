/**
 * Test-only seams for the Chat SDK adapters. Production code never calls
 * `setChatSdkTestHooks`, so every hook is unset in a running API. The
 * operator schema rejects `webhookVerifier`, and this module is the only
 * other way to set one.
 */
export interface ChatSdkTestHooks {
  /**
   * Replaces the Bot Framework JWT check of the Teams adapter. Tests cannot
   * mint a Microsoft-signed token, so they inject `() => true`.
   */
  teamsWebhookVerifier?: (request: Request, body: string) => boolean | Promise<boolean>;
  /**
   * Bot token factory for the Teams adapter, so an outbound send needs no
   * MSAL call to login.microsoftonline.com.
   */
  teamsToken?: () => string;
  /**
   * Skips the Discord Gateway loop. The loop logs in through `discord.js`
   * against the real Discord API, which `apiUrl` does not redirect.
   */
  disableDiscordGateway?: boolean;
  /** Typing keepalive interval, shortened so a test sees several renewals. */
  typingIntervalMs?: number;
  /** Typing keepalive hard cap, shortened so a test can reach it. */
  typingMaxMs?: number;
}

let hooks: ChatSdkTestHooks = {};

export function setChatSdkTestHooks(next: ChatSdkTestHooks): void {
  hooks = { ...next };
}

export function getChatSdkTestHooks(): Readonly<ChatSdkTestHooks> {
  return hooks;
}
