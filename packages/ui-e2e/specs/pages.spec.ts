import { expect, test } from "../fixtures";

test("pages list opens the public page and its share URL", async ({
  browser,
  page,
  seed,
  swarm,
  clean,
}, testInfo) => {
  await page.goto("/pages");

  await page.getByRole("link", { name: "e2e public page" }).click();
  await expect(page).toHaveURL(`/pages/${seed.pages.public.id}`);

  // The dashboard builds the share link from the active connection
  // (http://127.0.0.1:<port>), while the API reports `api_url` from
  // MCP_BASE_URL (http://localhost:<port>). Same page, two spellings of
  // loopback, so the manifest is compared on the path.
  const shareUrl = `${swarm.apiUrl}/p/${seed.pages.public.id}`;
  // `exact` keeps the header's "Open agent-swarm on GitHub" link out of the match.
  const openLink = page.getByRole("link", { name: "Open", exact: true });
  await expect(openLink).toHaveAttribute("href", shareUrl);
  expect(new URL(shareUrl).pathname).toBe(new URL(seed.pages.public.apiUrl).pathname);

  const anonymous = await browser.newContext();
  try {
    const publicPage = await anonymous.newPage();
    await publicPage.goto(shareUrl);
    await expect(publicPage.getByRole("heading", { name: "e2e public page" })).toBeVisible();
    const screenshot = testInfo.outputPath("public-page.png");
    await publicPage.screenshot({ path: screenshot });
    await testInfo.attach("public-page", { path: screenshot, contentType: "image/png" });

    const authed = await anonymous.request.get(seed.pages.authed.apiUrl);
    expect(authed.status()).toBe(401);
  } finally {
    await anonymous.close();
  }

  await clean.assertClean();
});
