import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import {
  createLookupClient,
  getSlackAppIconUrl,
  resetSlackAppIconCache,
  SLACK_APP_ICON_TTL_MS,
} from "../slack/app-icon";

function fakeClient(botsInfo: () => Promise<unknown>) {
  const authTest = mock(async () => ({ ok: true, bot_id: "B123" }));
  const info = mock(botsInfo);
  return {
    client: { auth: { test: authTest }, bots: { info } } as unknown as WebClient,
    authTest,
    info,
  };
}
const icons = (url: string) => async () => ({ bot: { icons: { image_72: url } } });

describe("getSlackAppIconUrl", () => {
  beforeEach(() => resetSlackAppIconCache());

  test("returns image_72, caches it, and refetches after the hour", async () => {
    let clock = 1_000;
    const now = () => clock;
    const { client, info } = fakeClient(icons("https://a/72.png"));
    const get = () => getSlackAppIconUrl({ getClient: () => client, now });
    expect(await get()).toBe("https://a/72.png");
    clock += SLACK_APP_ICON_TTL_MS - 1;
    expect(await get()).toBe("https://a/72.png");
    expect(info).toHaveBeenCalledTimes(1);
    clock += 1;
    expect(await get()).toBe("https://a/72.png");
    expect(info).toHaveBeenCalledTimes(2);
  });

  test("concurrent calls share one lookup", async () => {
    const { client, authTest } = fakeClient(icons("https://a/72.png"));
    const results = await Promise.all(
      [1, 2, 3].map(() => getSlackAppIconUrl({ getClient: () => client })),
    );
    expect(results).toEqual(["https://a/72.png", "https://a/72.png", "https://a/72.png"]);
    expect(authTest).toHaveBeenCalledTimes(1);
  });

  test("a failure is not cached, and Slack off wins over the cache", async () => {
    let fail = true;
    const { client, info } = fakeClient(async () => {
      if (fail) throw new Error("missing_scope");
      return { bot: { icons: { image_48: "https://a/48.png" } } };
    });
    expect(await getSlackAppIconUrl({ getClient: () => client })).toBeNull();
    fail = false;
    expect(await getSlackAppIconUrl({ getClient: () => client })).toBe("https://a/48.png");
    expect(info).toHaveBeenCalledTimes(2);
    expect(await getSlackAppIconUrl({ getClient: () => undefined })).toBeNull();
  });
});

describe("lookup client against a hanging Slack", () => {
  const hits: string[] = [];
  let hang = true;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").pop() ?? "";
      hits.push(method);
      if (method === "auth.test") {
        if (hang) await Bun.sleep(800);
        return Response.json({ ok: true, bot_id: "B123" });
      }
      return Response.json({ ok: true, bot: { icons: { image_72: "https://a/72.png" } } });
    },
  });
  afterAll(() => server.stop(true));
  const client = createLookupClient(
    { token: "xoxb-test", slackApiUrl: `http://localhost:${server.port}/api/` },
    200,
  );

  test("times out without retrying or reaching bots.info, then a new lookup works", async () => {
    resetSlackAppIconCache();
    const started = Date.now();
    expect(await getSlackAppIconUrl({ getClient: () => client })).toBeNull();
    expect(Date.now() - started).toBeLessThan(700);
    // Let the late auth.test response arrive: nothing may follow it.
    await Bun.sleep(900);
    expect(hits).toEqual(["auth.test"]);

    hang = false;
    expect(await getSlackAppIconUrl({ getClient: () => client })).toBe("https://a/72.png");
    expect(hits).toEqual(["auth.test", "auth.test", "bots.info"]);
  });
});
