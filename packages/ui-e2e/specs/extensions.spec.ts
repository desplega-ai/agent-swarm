import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

type Installed = { extension: { id: string; name: string } };

function card(page: Page, name: string) {
  return page.locator('[data-slot="card"]').filter({ hasText: name });
}

test("extension sheets return keyboard focus to the Details control that opened them", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { extension } = await api.post<Installed>("/api/extensions/install", {
    template: "task-digest",
  });
  try {
    const dialog = page.getByRole("dialog");
    const installedDetails = card(page, extension.name).getByRole("button", { name: "Details" });

    await page.goto("/settings/extensions");
    await installedDetails.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(installedDetails).toBeFocused();

    // A deep link has no opener: focus lands on that extension's card.
    await page.goto(`/settings/extensions/${extension.id}`);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(installedDetails).toBeFocused();

    const catalogDetails = card(page, "notify-on-complete").getByRole("button", {
      name: "Details",
    });
    await page.goto("/settings/extensions/new");
    await catalogDetails.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(catalogDetails).toBeFocused();

    await page.goto("/settings/extensions/new?template=notify-on-complete");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(catalogDetails).toBeFocused();

    await clean.assertClean();
  } finally {
    await api.delete(`/api/extensions/${extension.id}`);
  }
});

test("deleting an extension from its sheet stops every request for it", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { extension } = await api.post<Installed>("/api/extensions/install", {
    template: "require-ticket-ref",
  });
  const prefix = `/api/extensions/${extension.id}`;
  let deleted = false;
  const afterDelete: string[] = [];
  page.on("response", (response) => {
    if (response.request().method() === "DELETE" && response.url().endsWith(prefix)) deleted = true;
  });
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (deleted && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      afterDelete.push(`${request.method()} ${pathname}`);
    }
  });

  // Hold every list refresh from the delete on: focus and the grid must not
  // wait for it.
  let holdList = false;
  let heldLists = 0;
  let releaseList = () => {};
  const listReleased = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  await page.route("**/api/extensions", async (route) => {
    if (holdList && route.request().method() === "GET") {
      heldLists += 1;
      await listReleased;
    }
    await route.continue();
  });

  await page.goto(`/settings/extensions/${extension.id}`);
  const dialog = page.getByRole("dialog", { name: extension.name });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();
  holdList = true;
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => deleted).toBe(true);
  await expect.poll(() => heldLists).toBeGreaterThan(0);

  await expect(page.getByRole("dialog")).toBeHidden();
  // The deleted card cannot take focus back, even while the stale list still
  // renders it; the page's install button does.
  const install = page.getByRole("button", { name: "Install extension" }).first();
  await expect(install).toBeFocused();
  await expect(card(page, extension.name)).toHaveCount(0);

  holdList = false;
  releaseList();
  // Retries and the global poll would land well inside this window.
  await page.waitForTimeout(4_000);
  expect(afterDelete).toEqual([]);
  await expect(install).toBeFocused();
  await clean.assertClean();
});

test("closing an extension sheet stops polling that extension", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { extension } = await api.post<Installed>("/api/extensions/install", {
    template: "deploy-awareness",
  });
  const prefix = `/api/extensions/${extension.id}`;
  let closed = false;
  const afterClose: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (closed && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
      afterClose.push(`${request.method()} ${pathname}`);
    }
  });
  try {
    await page.goto(`/settings/extensions/${extension.id}`);
    const dialog = page.getByRole("dialog", { name: extension.name });
    await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    closed = true;

    // One full tick of the dashboard's 10s global poll.
    await page.waitForTimeout(11_000);
    expect(afterClose).toEqual([]);
    await clean.assertClean();
  } finally {
    await api.delete(prefix);
  }
});

for (const mode of ["failed", "pending"] as const) {
  test(`closing an extension sheet cancels a ${mode} request and its retries`, async ({
    page,
    api,
    seed,
  }) => {
    test.skip(!seed, "remote run without seed");
    const { extension } = await api.post<Installed>("/api/extensions/install", {
      template: "deploy-awareness",
    });
    const prefix = `/api/extensions/${extension.id}`;
    const isPerId = (url: URL) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
    let failing = false;
    let closed = false;
    let bundleFailures = 0;
    let held = 0;
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const afterClose: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (closed && isPerId(url)) afterClose.push(`${request.method()} ${url.pathname}`);
    });
    // Once armed, every per-id GET (bundle, versions, runs) answers 503, held
    // open first in pending mode.
    await page.route(isPerId, async (route) => {
      if (!failing || route.request().method() !== "GET") return route.continue();
      if (mode === "pending") {
        held += 1;
        await released;
      }
      if (new URL(route.request().url()).pathname === prefix) bundleFailures += 1;
      await route.fulfill({ status: 503, body: "unavailable" });
    });
    try {
      await page.goto(`/settings/extensions/${extension.id}`);
      const dialog = page.getByRole("dialog", { name: extension.name });
      await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible();

      // Past the 2s staleTime, a visibility change refetches the open sheet.
      await page.waitForTimeout(2_500);
      failing = true;
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange", { bubbles: true })),
      );
      // Poll fast: the first retry is 1s out and must land after the close.
      const fast = { intervals: [50] };
      if (mode === "failed") await expect.poll(() => bundleFailures, fast).toBeGreaterThan(0);
      else await expect.poll(() => held, fast).toBeGreaterThan(0);

      await page.keyboard.press("Escape");
      closed = true;
      await expect(page.getByRole("dialog")).toBeHidden();
      release();

      // Two retries at 1s and 2s backoff would land inside this window.
      await page.waitForTimeout(5_000);
      expect(afterClose).toEqual([]);
      // No clean.assertClean(): the 503s are injected on purpose.
    } finally {
      await api.delete(prefix);
    }
  });
}
