/**
 * Tiny fake Telegram Bot API for Chat SDK tests and local QA.
 *
 * Answers `POST|GET /bot<token>/<method>` with `{ ok: true, result }` for the
 * methods the Telegram adapter calls (getMe, getWebhookInfo, sendMessage, ...)
 * and records every call. `addFile(path, bytes)` serves a file through
 * `getFile` and the `/file/bot<token>/<path>` download route (the file id is
 * the path). `failSends(n)` answers the next n sends with HTTP 500. `failSetWebhook(true)`
 * answers `setWebhook` with HTTP 401 and a description that echoes the bot token (tests
 * check that the API redacts it). Point the API at it with
 * `CHAT_SDK_API_URL_OVERRIDES='{"telegram":"http://127.0.0.1:<port>"}'`.
 * `setWebhook` stores `url` (and `secret_token`); `getWebhookInfo` reports the stored url.
 *
 * Run standalone: `bun scripts/dev/telegram-bot-api-mock.ts` (prints the port).
 */

export interface TelegramMockCall {
  method: string;
  body: unknown;
}

export interface TelegramBotApiMock {
  url: string;
  port: number;
  calls: TelegramMockCall[];
  /** Serve `bytes` as the Telegram file whose `file_id` and `file_path` are `path`. */
  addFile: (path: string, bytes: Uint8Array) => void;
  /** Answer the next `count` send calls (sendMessage, sendRichMessage) with HTTP 500. */
  failSends: (count: number) => void;
  /** While on, `setWebhook` answers HTTP 401 with a description that contains the bot token. */
  failSetWebhook: (on: boolean) => void;
  stop: () => void;
}

export const TELEGRAM_MOCK_BOT = {
  id: 4242,
  is_bot: true,
  first_name: "Swarm",
  username: "swarm_test_bot",
};

let nextMessageId = 1000;

interface WebhookState {
  url: string;
  secretToken?: string;
}

function resultFor(
  method: string,
  body: Record<string, unknown>,
  files: Map<string, Uint8Array>,
  webhook: WebhookState,
): unknown {
  switch (method) {
    case "setWebhook":
      webhook.url = String(body.url ?? "");
      webhook.secretToken = typeof body.secret_token === "string" ? body.secret_token : undefined;
      return true;
    case "deleteWebhook":
      webhook.url = "";
      webhook.secretToken = undefined;
      return true;
    case "getFile": {
      const fileId = String(body.file_id ?? "");
      const bytes = files.get(fileId);
      return bytes
        ? {
            file_id: fileId,
            file_unique_id: fileId,
            file_size: bytes.byteLength,
            file_path: fileId,
          }
        : null;
    }
    case "getMe":
      return TELEGRAM_MOCK_BOT;
    case "getWebhookInfo":
      return { url: webhook.url, has_custom_certificate: false, pending_update_count: 0 };
    case "sendMessage":
    case "sendRichMessage":
      return {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: "private" },
        from: TELEGRAM_MOCK_BOT,
        text: body.text ?? (body.rich_message as { markdown?: string } | undefined)?.markdown,
      };
    default:
      return true;
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

export function startTelegramBotApiMock(port = 0): TelegramBotApiMock {
  const calls: TelegramMockCall[] = [];
  const files = new Map<string, Uint8Array>();
  const webhook: WebhookState = { url: "" };
  let failingSends = 0;
  let failingSetWebhook = false;
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const pathname = new URL(req.url).pathname;
      const download = pathname.match(/^\/file\/bot[^/]+\/(.+)$/);
      if (download?.[1]) {
        const bytes = files.get(decodeURIComponent(download[1]));
        return bytes ? new Response(bytes) : new Response("Not Found", { status: 404 });
      }
      const match = pathname.match(/^\/bot([^/]+)\/([A-Za-z]+)$/);
      const method = match?.[2];
      if (!method) return Response.json({ ok: false, description: "Not Found" }, { status: 404 });
      const body = await readBody(req);
      calls.push({ method, body });
      if (failingSetWebhook && method === "setWebhook") {
        return Response.json(
          { ok: false, error_code: 401, description: `Unauthorized: bot${match[1]} rejected` },
          { status: 401 },
        );
      }
      if (failingSends > 0 && /^send(Rich)?Message$/.test(method)) {
        failingSends -= 1;
        return Response.json(
          { ok: false, error_code: 500, description: "Internal Server Error" },
          { status: 500 },
        );
      }
      const result = resultFor(method, body, files, webhook);
      if (method === "getFile" && result === null) {
        return Response.json(
          { ok: false, error_code: 400, description: "Bad Request: file not found" },
          { status: 400 },
        );
      }
      return Response.json({ ok: true, result });
    },
  });
  const boundPort = server.port ?? port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    calls,
    addFile: (path, bytes) => files.set(path, bytes),
    failSends: (count) => {
      failingSends = count;
    },
    failSetWebhook: (on) => {
      failingSetWebhook = on;
    },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const mock = startTelegramBotApiMock(Number(process.env.PORT ?? 0));
  console.log(mock.port);
  console.error(`[telegram-mock] listening on ${mock.url}`);
}
