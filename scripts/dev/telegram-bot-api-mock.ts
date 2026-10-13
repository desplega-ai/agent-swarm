/**
 * Tiny fake Telegram Bot API for Chat SDK tests and local QA.
 *
 * Answers `POST|GET /bot<token>/<method>` with `{ ok: true, result }` for the
 * methods the Telegram adapter calls (getMe, getWebhookInfo, sendMessage, ...)
 * and records every call. Point the API at it with
 * `CHAT_SDK_API_URL_OVERRIDES='{"telegram":"http://127.0.0.1:<port>"}'`.
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
  stop: () => void;
}

export const TELEGRAM_MOCK_BOT = {
  id: 4242,
  is_bot: true,
  first_name: "Swarm",
  username: "swarm_test_bot",
};

let nextMessageId = 1000;

function resultFor(method: string, body: Record<string, unknown>): unknown {
  switch (method) {
    case "getMe":
      return TELEGRAM_MOCK_BOT;
    case "getWebhookInfo":
      return { url: "", has_custom_certificate: false, pending_update_count: 0 };
    case "sendMessage":
      return {
        message_id: nextMessageId++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: body.chat_id, type: "private" },
        from: TELEGRAM_MOCK_BOT,
        text: body.text,
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
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const match = new URL(req.url).pathname.match(/^\/bot[^/]+\/([A-Za-z]+)$/);
      if (!match?.[1])
        return Response.json({ ok: false, description: "Not Found" }, { status: 404 });
      const body = await readBody(req);
      calls.push({ method: match[1], body });
      return Response.json({ ok: true, result: resultFor(match[1], body) });
    },
  });
  const boundPort = server.port ?? port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    calls,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const mock = startTelegramBotApiMock(Number(process.env.PORT ?? 0));
  console.log(mock.port);
  console.error(`[telegram-mock] listening on ${mock.url}`);
}
