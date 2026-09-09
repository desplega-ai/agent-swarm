import { expect, test } from "../fixtures";

type BrowserPeer = {
  userId: string;
  name: string;
  kind: string;
};

type BrowserRoom = {
  state: Record<string, unknown>;
  me?: BrowserPeer;
  stale: boolean;
  apply: (operations: Array<{ type: "set"; path: string[]; value: unknown }>) => Promise<void>;
  change: (fn: (state: Record<string, unknown>) => void) => Promise<void>;
  close: () => Promise<void>;
};

type BrowserSdk = {
  room: (name: string, options?: { schemaVersion?: number }) => Promise<BrowserRoom>;
};

type BrowserRoomWindow = Window & {
  swarmSdk: BrowserSdk;
  realtimeRooms?: Record<string, BrowserRoom>;
};

test("realtime browser replicas converge and recover after a stale schema reset", async ({
  browser,
  page,
  seed,
  swarm,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");

  const pageId = seed!.pages.public.id;
  const namespace = `task:page:${pageId}`;
  const roomName = `browser_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

  const tokenResponse = await page.request.post(
    `${swarm.apiUrl}/api/users/${seed!.user.id}/mcp-tokens`,
    {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
      data: { label: `realtime-browser-${roomName}` },
    },
  );
  expect(tokenResponse.status()).toBe(200);
  const tokenBody = (await tokenResponse.json()) as { plaintext: string };
  expect(tokenBody.plaintext).toBeTruthy();

  const launchResponse = await page.request.post(`${swarm.apiUrl}/api/pages/${pageId}/launch`, {
    headers: { Authorization: `Bearer ${tokenBody.plaintext}` },
  });
  expect(launchResponse.status()).toBe(204);
  const cookie = launchResponse.headers()["set-cookie"]?.match(/page_session=([^;]+)/)?.[1];
  expect(cookie).toBeTruthy();

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    await firstContext.addCookies([
      { name: "page_session", value: cookie!, url: `${swarm.apiUrl}/` },
    ]);
    await secondContext.addCookies([
      { name: "page_session", value: cookie!, url: `${swarm.apiUrl}/` },
    ]);
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    const shareUrl = `${swarm.apiUrl}/p/${pageId}`;
    await Promise.all([first.goto(shareUrl), second.goto(shareUrl)]);

    const firstOpened = await first.evaluate(async (name: string) => {
      const browserWindow = window as unknown as BrowserRoomWindow;
      const room = await browserWindow.swarmSdk.room(name);
      browserWindow.realtimeRooms ??= {};
      browserWindow.realtimeRooms[name] = room;
      return { me: room.me, state: room.state };
    }, roomName);
    const secondOpened = await second.evaluate(async (name: string) => {
      const browserWindow = window as unknown as BrowserRoomWindow;
      const room = await browserWindow.swarmSdk.room(name);
      browserWindow.realtimeRooms ??= {};
      browserWindow.realtimeRooms[name] = room;
      return { state: room.state };
    }, roomName);
    expect(firstOpened.me).toMatchObject({
      userId: seed!.user.id,
      name: seed!.user.name,
      kind: "user",
    });
    expect(secondOpened.state).toEqual({});

    await first.evaluate(async (name: string) => {
      const room = (window as unknown as BrowserRoomWindow).realtimeRooms![name]!;
      await room.apply([{ type: "set", path: ["fromFirst"], value: true }]);
    }, roomName);
    await expect
      .poll(
        () =>
          second.evaluate(
            (name: string) => (window as unknown as BrowserRoomWindow).realtimeRooms![name]!.state,
            roomName,
          ),
        {
          message: "second browser room should receive the first replica update",
        },
      )
      .toMatchObject({ fromFirst: true });

    await second.evaluate(async (name: string) => {
      const room = (window as unknown as BrowserRoomWindow).realtimeRooms![name]!;
      await room.apply([{ type: "set", path: ["fromSecond"], value: true }]);
    }, roomName);
    await expect
      .poll(
        () =>
          first.evaluate(
            (name: string) => (window as unknown as BrowserRoomWindow).realtimeRooms![name]!.state,
            roomName,
          ),
        {
          message: "first browser room should receive the second replica update",
        },
      )
      .toMatchObject({ fromFirst: true, fromSecond: true });

    const optimistic = await first.evaluate(async (name: string) => {
      const room = (window as unknown as BrowserRoomWindow).realtimeRooms![name]!;
      let error = "";
      try {
        await room.change((state) => {
          let seed = 0x1090;
          const chunks: string[] = [];
          for (let offset = 0; offset < 1_900_000; offset += 8192) {
            let chunk = "";
            for (let index = 0; index < Math.min(8192, 1_900_000 - offset); index++) {
              seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
              chunk += String.fromCharCode(32 + (seed % 95));
            }
            chunks.push(chunk);
          }
          state.oversized = chunks.join("");
        });
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      }
      if (!error) throw new Error("oversized optimistic room.change unexpectedly succeeded");
      await room.apply([{ type: "set", path: ["afterReject"], value: true }]);
      return { error, state: room.state };
    }, roomName);
    expect(optimistic.error).toMatch(/invalid realtime message|size|limit|exceed/i);
    expect(optimistic.state).toMatchObject({
      fromFirst: true,
      fromSecond: true,
      afterReject: true,
    });
    await expect
      .poll(
        () =>
          second.evaluate(
            (name: string) => (window as unknown as BrowserRoomWindow).realtimeRooms![name]!.state,
            roomName,
          ),
        {
          message: "room.apply should succeed after an optimistic write rejection",
        },
      )
      .toMatchObject({ afterReject: true });

    const resetResponse = await page.request.post(`${swarm.apiUrl}/api/rooms/reset`, {
      headers: {
        Authorization: `Bearer ${swarm.apiKey}`,
        "X-Agent-ID": seed!.agents.lead,
      },
      data: {
        namespace,
        name: roomName,
        schemaVersion: 2,
        state: { schemaReset: true },
      },
    });
    expect(resetResponse.status()).toBe(200);

    await expect
      .poll(
        () =>
          first.evaluate(
            (name: string) => (window as unknown as BrowserRoomWindow).realtimeRooms![name]!.stale,
            roomName,
          ),
        {
          message: "first replica should become stale after a schema reset",
        },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          second.evaluate(
            (name: string) => (window as unknown as BrowserRoomWindow).realtimeRooms![name]!.stale,
            roomName,
          ),
        {
          message: "second replica should become stale after a schema reset",
        },
      )
      .toBe(true);

    const reopened = await first.evaluate(async (name: string) => {
      const browserWindow = window as unknown as BrowserRoomWindow;
      await browserWindow.realtimeRooms![name]!.close();
      const room = await browserWindow.swarmSdk.room(name, { schemaVersion: 2 });
      browserWindow.realtimeRooms![name] = room;
      return { stale: room.stale, state: room.state };
    }, roomName);
    expect(reopened).toEqual({ stale: false, state: { schemaReset: true } });
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }

  await clean.assertClean();
});
