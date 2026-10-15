import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { fetchDiscordGuilds, resetDiscordGuildsCache } from "../integrations/chat-sdk/discord-api";
import { snapshotChatSdkEnv } from "./chat-sdk-harness";

const restoreEnv = snapshotChatSdkEnv();
let server: ReturnType<typeof Bun.serve>;
let hits: Array<{ auth: string | null; path: string }> = [];
let respond: () => Response = () => Response.json([]);

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      hits.push({ auth: request.headers.get("authorization"), path: url.pathname });
      return respond();
    },
  });
  process.env.CHAT_SDK_API_URL_OVERRIDES = JSON.stringify({
    discord: `http://127.0.0.1:${server.port}`,
  });
});

afterEach(() => {
  hits = [];
  resetDiscordGuildsCache();
});

afterAll(() => {
  server.stop(true);
  restoreEnv();
});

describe("fetchDiscordGuilds", () => {
  test("lists the bot's servers with the Bot authorization header", async () => {
    respond = () =>
      Response.json([
        { id: "1", name: "sheetsql" },
        { id: "2", name: "test server" },
      ]);
    expect(await fetchDiscordGuilds("tok-1")).toEqual({
      count: 2,
      names: ["sheetsql", "test server"],
    });
    expect(hits).toEqual([{ auth: "Bot tok-1", path: "/users/@me/guilds" }]);
  });

  test("caches per token for a minute, so the status poll does not hammer Discord", async () => {
    respond = () => Response.json([]);
    const now = 1_000_000;
    expect(await fetchDiscordGuilds("tok-2", now)).toEqual({ count: 0, names: [] });
    expect(await fetchDiscordGuilds("tok-2", now + 30_000)).toEqual({ count: 0, names: [] });
    expect(hits).toHaveLength(1);
    await fetchDiscordGuilds("tok-2", now + 61_000);
    expect(hits).toHaveLength(2);
    // Another token is another bot.
    await fetchDiscordGuilds("tok-3", now + 61_000);
    expect(hits).toHaveLength(3);
  });

  test("an HTTP error or a bad body yields undefined, without throwing", async () => {
    respond = () => new Response("nope", { status: 401 });
    expect(await fetchDiscordGuilds("tok-4")).toBeUndefined();
    resetDiscordGuildsCache();
    respond = () => Response.json({ not: "an array" });
    expect(await fetchDiscordGuilds("tok-4")).toBeUndefined();
  });
});
