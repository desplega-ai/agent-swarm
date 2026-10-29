import { afterAll, afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

// A local Slack Web API. Each test uses its own bot token, so the per-token
// cache never leaks between tests.
type Behaviour = { hangMs?: number; botsInfoFails?: number };
const behaviour = new Map<string, Behaviour>();
const hits: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const method = new URL(req.url).pathname.split("/").pop() ?? "";
    const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    hits.push(`${token} ${method}`);
    const b = behaviour.get(token) ?? {};
    if (method === "auth.test") {
      if (b.hangMs) await Bun.sleep(b.hangMs);
      return Response.json({ ok: true, bot_id: "B123" });
    }
    if (b.botsInfoFails) {
      b.botsInfoFails--;
      return Response.json({ ok: false, error: "missing_scope" });
    }
    return Response.json({ ok: true, bot: { icons: { image_72: `https://a/${token}.png` } } });
  },
});
const slackApiUrl = `http://localhost:${server.port}/api/`;
let token: string | null = null;
mock.module("../slack/app", () => ({
  getSlackApp: () => (token ? { client: { token, slackApiUrl } } : null),
}));
const { getSlackAppIconUrl } = await import("../slack/app-icon");

const calls = (t: string, method: string) => hits.filter((h) => h === `${t} ${method}`).length;

afterEach(() => setSystemTime());
afterAll(() => server.stop(true));

describe("getSlackAppIconUrl", () => {
  test("returns the bot's image_72, cached for an hour, then asks again", async () => {
    token = "xoxb-cache";
    expect(await getSlackAppIconUrl()).toBe("https://a/xoxb-cache.png");
    expect(await getSlackAppIconUrl()).toBe("https://a/xoxb-cache.png");
    expect(calls(token, "bots.info")).toBe(1);
    setSystemTime(new Date(Date.now() + 60 * 60 * 1000));
    expect(await getSlackAppIconUrl()).toBe("https://a/xoxb-cache.png");
    expect(calls(token, "bots.info")).toBe(2);
  });

  test("Slack off returns null even with an avatar cached", async () => {
    token = "xoxb-off";
    expect(await getSlackAppIconUrl()).toBe("https://a/xoxb-off.png");
    token = null;
    expect(await getSlackAppIconUrl()).toBeNull();
  });

  test("concurrent calls share one lookup", async () => {
    token = "xoxb-concurrent";
    const results = await Promise.all([1, 2, 3].map(() => getSlackAppIconUrl()));
    expect(results).toEqual(Array(3).fill("https://a/xoxb-concurrent.png"));
    expect(calls(token, "auth.test")).toBe(1);
  });

  test("a failed lookup is not cached", async () => {
    token = "xoxb-flaky";
    behaviour.set(token, { botsInfoFails: 1 });
    expect(await getSlackAppIconUrl()).toBeNull();
    expect(await getSlackAppIconUrl()).toBe("https://a/xoxb-flaky.png");
    expect(calls(token, "bots.info")).toBe(2);
  });

  test(
    "a hanging auth.test times out without a retry or a bots.info, then a new lookup works",
    async () => {
      token = "xoxb-hang";
      behaviour.set(token, { hangMs: 4_000 });
      const started = Date.now();
      expect(await getSlackAppIconUrl()).toBeNull();
      expect(Date.now() - started).toBeLessThan(3_500);
      // Let the late auth.test reply arrive: nothing may follow it.
      await Bun.sleep(4_000 - (Date.now() - started) + 300);
      expect(calls(token, "auth.test")).toBe(1);
      expect(calls(token, "bots.info")).toBe(0);

      behaviour.set(token, {});
      expect(await getSlackAppIconUrl()).toBe("https://a/xoxb-hang.png");
      expect(calls(token, "auth.test")).toBe(2);
    },
    { timeout: 15_000 },
  );
});
