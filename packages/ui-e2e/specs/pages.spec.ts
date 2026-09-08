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

    const authed = await anonymous.request.get(seed!.pages.authed.apiUrl);
    expect(authed.status()).toBe(401);
  } finally {
    await anonymous.close();
  }

  await clean.assertClean();
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
