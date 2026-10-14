import { scrubSecrets } from "@/utils/secret-scrubber";
import { errorMessage } from "./logger";

const TELEGRAM_TIMEOUT_MS = 10_000;

/** A Bot API call that did not return `ok: true`. The message never carries the token. */
export class TelegramBotApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramBotApiError";
  }
}

/**
 * One Telegram Bot API call. Shared by the register-webhook action and the
 * command registration at adapter start, so both hit the same base URL
 * (`resolveAdapterApiUrl`) and scrub the token out of every error.
 */
export async function callTelegramBotApi(
  baseUrl: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new TelegramBotApiError(
        `Telegram ${method} failed: no response from the Bot API within ${TELEGRAM_TIMEOUT_MS / 1000} s`,
      );
    }
    // Fetch errors can echo the URL, which carries the bot token.
    throw new TelegramBotApiError(
      `Telegram ${method} failed: ${scrubSecrets(errorMessage(error).replaceAll(token, "[REDACTED]"))}`,
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    result?: unknown;
    description?: string;
  } | null;
  if (!response.ok || !payload?.ok) {
    const description = payload?.description ?? `HTTP ${response.status}`;
    throw new TelegramBotApiError(
      `Telegram ${method} failed: ${scrubSecrets(description.replaceAll(token, "[REDACTED]"))}`,
    );
  }
  return payload.result;
}
