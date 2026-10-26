import { expect, test } from "../fixtures";

// The teammate path: an admin invites a Requester from People and reads the
// one-time link. A second browser context, with no saved connection, opens
// the link: /join trades the code for the teammate's own token, saves it as a
// connection and lands on Home. Reusing the link shows the expired copy.
const EMAIL = "e2e-ada@example.com";
// `browser.newContext()` inherits the fixture's storageState (the admin's
// connection): a teammate's browser starts empty.
const FRESH_BROWSER = { storageState: { cookies: [], origins: [] } };

test.describe("invites", () => {
  test.describe.configure({ mode: "serial" });

  test("an admin invites a Requester who joins with the link", async ({ page, browser }) => {
    await page.goto("/people");
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Invite a teammate" })).toBeVisible();
    await dialog.getByLabel("Email").fill(EMAIL);
    await dialog.getByLabel("Name (optional)").fill("Ada E2E");
    // Requester is preselected.
    await expect(dialog.getByRole("radio", { name: "Requester" })).toBeChecked();
    await dialog.getByRole("button", { name: "Create invite link" }).click();

    await expect(dialog.getByRole("heading", { name: "Invite link ready" })).toBeVisible();
    await expect(dialog).toContainText("Anyone with this link joins as Requester.");
    await expect(dialog).toContainText("one use.");
    const link = await dialog.getByLabel("Invite link", { exact: true }).inputValue();
    const url = new URL(link);
    expect(url.pathname).toBe("/join");
    expect(url.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const teammate = await browser.newContext(FRESH_BROWSER);
    try {
      const ada = await teammate.newPage();
      await ada.goto(link);
      await ada.waitForURL((current) => current.pathname === "/");
      // The code left the address bar.
      expect(new URL(ada.url()).searchParams.get("code")).toBeNull();
      await expect(ada.getByRole("link", { name: "Tasks", exact: true })).toBeVisible();
      await expect(ada.getByRole("link", { name: "People", exact: true })).toHaveCount(0);
      // The saved connection holds the teammate's own token.
      const stored = await ada.evaluate(() => localStorage.getItem("agent-swarm-connections"));
      const connections = JSON.parse(stored ?? "{}") as {
        connections: { apiKey: string }[];
        activeId: string;
      };
      expect(connections.connections).toHaveLength(1);
      expect(connections.connections[0].apiKey.startsWith("aswt_")).toBe(true);

      // The Requester can start a task: the new-session composer shows.
      await ada.goto("/sessions");
      await expect(ada.getByPlaceholder("What's the goal?")).toBeVisible();
    } finally {
      await teammate.close();
    }

    // The link is single-use: a third session sees the expired copy.
    const third = await browser.newContext(FRESH_BROWSER);
    try {
      const reuse = await third.newPage();
      await reuse.goto(link);
      await expect(
        reuse.getByText("This invite link is used or expired. Ask the admin for a new one."),
      ).toBeVisible();
    } finally {
      await third.close();
    }

    // A joined teammate cannot be invited again.
    await dialog.getByRole("button", { name: "Invite another" }).click();
    await dialog.getByLabel("Email").fill(EMAIL);
    await dialog.getByRole("button", { name: "Create invite link" }).click();
    await expect(dialog).toContainText(`${EMAIL} already has access.`);
  });
});
