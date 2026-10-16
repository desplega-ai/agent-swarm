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

  await page.goto(`/settings/extensions/${extension.id}`);
  const dialog = page.getByRole("dialog", { name: extension.name });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => deleted).toBe(true);

  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(card(page, extension.name)).toHaveCount(0);

  // Retries and the global poll would land well inside this window.
  await page.waitForTimeout(4_000);
  expect(afterDelete).toEqual([]);
  // The deleted card cannot take focus back; the page's install button does.
  await expect(page.getByRole("button", { name: "Install extension" }).first()).toBeFocused();
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
