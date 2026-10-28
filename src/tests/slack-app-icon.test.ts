import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import { getSlackAppIconUrl, resetSlackAppIconCache } from "../slack/app-icon";

function fakeClient(botsInfo: () => Promise<unknown>) {
  const authTest = mock(async () => ({ ok: true, bot_id: "B123" }));
  const info = mock(botsInfo);
  return {
    client: { auth: { test: authTest }, bots: { info } } as unknown as WebClient,
    info,
  };
}

describe("getSlackAppIconUrl", () => {
  beforeEach(() => resetSlackAppIconCache());

  test("returns the bot's image_72 and caches it", async () => {
    const { client, info } = fakeClient(async () => ({
      bot: { icons: { image_36: "https://a/36.png", image_72: "https://a/72.png" } },
    }));
    expect(await getSlackAppIconUrl(() => client)).toBe("https://a/72.png");
    expect(await getSlackAppIconUrl(() => client)).toBe("https://a/72.png");
    expect(info).toHaveBeenCalledTimes(1);
  });

  test("is null with Slack off, and a failed lookup is not cached", async () => {
    expect(await getSlackAppIconUrl(() => undefined)).toBeNull();
    let fail = true;
    const { client, info } = fakeClient(async () => {
      if (fail) throw new Error("missing_scope");
      return { bot: { icons: { image_48: "https://a/48.png" } } };
    });
    expect(await getSlackAppIconUrl(() => client)).toBeNull();
    fail = false;
    expect(await getSlackAppIconUrl(() => client)).toBe("https://a/48.png");
    expect(info).toHaveBeenCalledTimes(2);
  });
});
