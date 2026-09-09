import { expect, test } from "../fixtures";

test("pages list opens the public page and its share URL", async ({
  browser,
  page,
  seed,
  swarm,
  clean,
}, testInfo) => {
  test.skip(!seed, "remote run without seed");
  await page.goto("/pages");

  await page.getByRole("link", { name: "e2e public page" }).click();
  await expect(page).toHaveURL(`/pages/${seed!.pages.public.id}`);

  // The dashboard builds the share link from the active connection
  // (http://127.0.0.1:<port>), while the API reports `api_url` from
  // MCP_BASE_URL (http://localhost:<port>). Same page, two spellings of
  // loopback, so the manifest is compared on the path.
  const shareUrl = `${swarm.apiUrl}/p/${seed!.pages.public.id}`;
  // `exact` keeps the header's "Open agent-swarm on GitHub" link out of the match.
  const openLink = page.getByRole("link", { name: "Open", exact: true });
  await expect(openLink).toHaveAttribute("href", shareUrl);
  expect(new URL(shareUrl).pathname).toBe(new URL(seed!.pages.public.apiUrl).pathname);

  const anonymous = await browser.newContext();
  try {
    const publicPage = await anonymous.newPage();
    await publicPage.goto(shareUrl);
    await expect(publicPage.getByRole("heading", { name: "e2e public page" })).toBeVisible();
    const screenshot = testInfo.outputPath("public-page.png");
    await publicPage.screenshot({ path: screenshot });
    await testInfo.attach("public-page", { path: screenshot, contentType: "image/png" });

    // Use this worker's API, as the public-page check above does.
    const authed = await anonymous.request.get(`${swarm.apiUrl}/p/${seed!.pages.authed.id}`);
    expect(authed.status()).toBe(401);
  } finally {
    await anonymous.close();
  }

  await clean.assertClean();
});

test("public page preserves authored styles after Tailwind loads", async ({
  browser,
  page,
  seed,
  swarm,
}) => {
  test.skip(!seed, "remote run without seed");
  const createResponse = await page.request.post(`${swarm.apiUrl}/api/pages`, {
    headers: {
      Authorization: `Bearer ${swarm.apiKey}`,
      "X-Agent-ID": seed!.agents.lead,
    },
    data: {
      title: "e2e authored styles",
      slug: `e2e-authored-styles-${crypto.randomUUID()}`,
      contentType: "text/html",
      authMode: "public",
      body: `<!doctype html>
<html>
  <head>
    <style>
      body { max-width: 800px; margin: 32px auto; }
      h1 { font-size: 42px; font-weight: 800; }
      h2 { margin: 17px 0 19px; }
      p { margin: 11px 0 13px; }
      ul { list-style-type: square; }
      a { color: rgb(120, 60, 180); text-decoration: underline; }
    </style>
  </head>
  <body>
    <h1>Authored heading</h1>
    <h2>Authored section</h2>
    <p>Authored paragraph</p>
    <ul><li>Visible marker</li></ul>
    <a href="#target">Authored link</a>
    <div id="tailwind-box" class="flex border-4 border-blue-500">Tailwind utility box</div>
  </body>
</html>`,
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as { id: string };

  try {
    const anonymous = await browser.newContext();
    try {
      const publicPage = await anonymous.newPage();
      await publicPage.goto(`${swarm.apiUrl}/p/${created.id}`);

      const utilityBox = publicPage.locator("#tailwind-box");
      await expect(utilityBox).toHaveCSS("display", "flex");
      await expect(utilityBox).toHaveCSS("border-top-width", "4px");
      await expect(utilityBox).toHaveCSS("border-top-style", "solid");

      const styles = await publicPage.evaluate(() => {
        const read = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const heading = read("h1");
        const section = read("h2");
        const paragraph = read("p");
        const list = read("ul");
        const link = read("a");
        const body = getComputedStyle(document.body);
        return {
          heading: { fontSize: heading.fontSize, fontWeight: heading.fontWeight },
          section: { marginTop: section.marginTop, marginBottom: section.marginBottom },
          paragraph: { marginTop: paragraph.marginTop, marginBottom: paragraph.marginBottom },
          listStyleType: list.listStyleType,
          bodyMargin: { top: body.marginTop, bottom: body.marginBottom },
          centered: Number.parseFloat(body.marginLeft) > 0 && body.marginLeft === body.marginRight,
          link: { color: link.color, textDecorationLine: link.textDecorationLine },
        };
      });

      expect(styles).toEqual({
        heading: { fontSize: "42px", fontWeight: "800" },
        section: { marginTop: "17px", marginBottom: "19px" },
        paragraph: { marginTop: "11px", marginBottom: "13px" },
        listStyleType: "square",
        bodyMargin: { top: "32px", bottom: "32px" },
        centered: true,
        link: { color: "rgb(120, 60, 180)", textDecorationLine: "underline" },
      });
    } finally {
      await anonymous.close();
    }
  } finally {
    const removed = await page.request.delete(`${swarm.apiUrl}/api/pages/${created.id}`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
    });
    expect(removed.status()).toBe(204);
  }
});

test("page viewer forwards its query params to the page body", async ({
  page,
  seed,
  clean,
}, testInfo) => {
  test.skip(!seed, "remote run without seed");
  const id = seed!.pages.public.id;

  // `key` is SPA-reserved (password unlock) and must not reach the body;
  // everything else rides along so a page can deep-link on its own params.
  await page.goto(`/pages/${id}?target=pr-1373&status=failed&key=secret`);
  const frame = page.locator("iframe[title='e2e public page']");
  const forwarded = new RegExp(`/p/${id}\\?target=pr-1373&status=failed$`);
  await expect(frame).toHaveAttribute("src", forwarded);
  await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveAttribute(
    "href",
    forwarded,
  );
  const screenshot = testInfo.outputPath("page-query-passthrough.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("page-query-passthrough", { path: screenshot, contentType: "image/png" });

  // Toggling full mode keeps the forwarded params on both the route and the body.
  await page.getByRole("link", { name: "Full" }).click();
  await expect(page).toHaveURL(`/pages/${id}?target=pr-1373&status=failed&mode=full`);
  await expect(page.locator("iframe[title='e2e public page']")).toHaveAttribute("src", forwarded);
  await expect(page.getByRole("link", { name: "Exit full" })).toHaveAttribute(
    "href",
    `/pages/${id}?target=pr-1373&status=failed`,
  );

  await clean.assertClean();
});

test("saved room inspector decodes persisted state without creating a missing room", async ({
  api,
  page,
  seed,
  swarm,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const pageId = seed!.pages.public.id;
  const namespace = `task:page:${pageId}`;
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const savedRoom = `saved_${suffix}`;
  const missingRoom = `missing_${suffix}`;
  const listRooms = (name: string) => {
    const query = new URLSearchParams({ prefix: `_room/${name}`, limit: "1" });
    return api.get<{ entries: Array<{ key: string }>; total: number }>(
      `/api/kv/_/${encodeURIComponent(namespace)}?${query}`,
    );
  };

  const changeResponse = await page.request.post(`${swarm.apiUrl}/api/rooms/change`, {
    headers: {
      Authorization: `Bearer ${swarm.apiKey}`,
      "X-Agent-ID": seed!.agents.lead,
    },
    data: {
      namespace,
      name: savedRoom,
      operations: [
        { type: "set", path: ["project"], value: "Realtime launch" },
        { type: "set", path: ["progress"], value: { complete: 3, total: 5 } },
      ],
    },
  });
  expect(changeResponse.status()).toBe(200);

  await expect
    .poll(async () => (await listRooms(savedRoom)).entries[0]?.key, {
      message: "room snapshot should persist before UI inspection",
    })
    .toBe(`_room/${savedRoom}`);

  await page.goto(`/pages/${pageId}`);
  await page.getByRole("button", { name: "Saved room state" }).click();
  const roomName = page.getByLabel("Room name");
  await roomName.fill(savedRoom);
  await page.getByRole("button", { name: "Inspect saved state" }).click();

  await expect(page.getByText("Schema version 1")).toBeVisible();
  const decodedState = page.locator("pre").filter({ hasText: "Realtime launch" });
  await expect(decodedState).toContainText('"project": "Realtime launch"');
  await expect(decodedState).toContainText('"complete": 3');
  await expect(decodedState).toContainText('"total": 5');

  await roomName.fill(missingRoom);
  await page.getByRole("button", { name: "Inspect saved state" }).click();
  await expect(page.getByText("This room has no saved state yet.")).toBeVisible();
  expect(await listRooms(missingRoom)).toMatchObject({ entries: [], total: 0 });

  await clean.assertClean();
});
