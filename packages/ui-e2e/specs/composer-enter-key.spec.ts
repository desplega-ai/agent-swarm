import { expect, test } from "../fixtures";

/**
 * Covers the `/sessions` composer's Enter-key policy (`lib/enter-submit.ts`):
 * desktop Enter submits, mobile Enter inserts a newline, IME composition
 * never submits. The `mobile-iphone` Playwright project (see
 * `playwright.config.ts`) emulates `isMobile`/`hasTouch`, which is what
 * Chromium's device-emulation mode uses to answer `pointer: coarse` — the
 * same signal a real iOS Safari/Chrome tab reports. A physical iPhone still
 * needs a manual check (see the PR test plan); emulation cannot drive the
 * real on-screen keyboard.
 */

async function interceptTaskCreate(page: import("@playwright/test").Page) {
  const calls: string[] = [];
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { task: string };
    calls.push(body.task);
    return route.fulfill({ json: { id: "e2e-composer-task", status: "pending" } });
  });
  return calls;
}

test("desktop: Enter submits, Shift+Enter inserts a newline", async ({ page, seed, isMobile }) => {
  test.skip(!seed, "remote run without seed");
  test.skip(isMobile, "desktop-only — see the mobile test below");

  const calls = await interceptTaskCreate(page);
  await page.goto("/sessions");
  const composer = page.getByPlaceholder("What's the goal?");
  await expect(composer).toBeVisible();

  await composer.fill("line one");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("line two");
  await expect(composer).toHaveValue("line one\nline two");
  expect(calls).toEqual([]);

  await composer.press("Enter");
  await expect.poll(() => calls).toEqual(["line one\nline two"]);
  // A successful create navigates away to the new session — the strongest
  // signal available that Enter actually submitted, since the draft doesn't
  // persist to be re-checked on this page.
  await expect(page).toHaveURL(/\/sessions\/e2e-composer-task$/);
});

test("mobile: Enter inserts a newline, blank lines survive, the send button submits", async ({
  page,
  seed,
  isMobile,
}) => {
  test.skip(!seed, "remote run without seed");
  test.skip(!isMobile, "mobile-only — see the desktop test above");

  const calls = await interceptTaskCreate(page);
  await page.goto("/sessions");
  const composer = page.getByPlaceholder("What's the goal?");
  await expect(composer).toBeVisible();

  await composer.fill("line one");
  await composer.press("Enter"); // soft-keyboard Return: newline, not submit
  await composer.press("Enter"); // a second Return leaves a blank line
  await composer.pressSequentially("line two");
  await expect(composer).toHaveValue("line one\n\nline two");
  expect(calls).toEqual([]);

  await page.getByRole("button", { name: "Start session" }).click();
  await expect.poll(() => calls).toEqual(["line one\n\nline two"]);
});

test("IME composition never submits the composer, on any device", async ({
  page,
  seed,
  isMobile,
}) => {
  test.skip(!seed, "remote run without seed");
  // Enter never submits on a coarse pointer regardless of composing state —
  // the send button does. That path is exercised by the mobile test above;
  // it can't distinguish a present guard from a missing one, so skip here.
  test.skip(isMobile, "mobile Enter never submits — composing can't change that, see above");

  const calls = await interceptTaskCreate(page);
  await page.goto("/sessions");
  const composer = page.getByPlaceholder("What's the goal?");
  await expect(composer).toBeVisible();

  await composer.fill("こんにちは");
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  // A synchronous check here would pass whether or not the guard fired —
  // the mocked create POST resolves a tick later. Give it a real window to
  // land before asserting, so a missing guard actually fails this test.
  await page.waitForTimeout(500);
  expect(calls).toEqual([]);
  await expect(composer).toHaveValue("こんにちは");

  // Composition ends; the same Enter now submits.
  await composer.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: false,
    bubbles: true,
    cancelable: true,
  });
  await expect.poll(() => calls).toEqual(["こんにちは"]);
});
