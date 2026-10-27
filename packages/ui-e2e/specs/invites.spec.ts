import { expect, test } from "../fixtures";

// The teammate path: an admin invites a Requester from People and reads the
// one-time link. A second browser context, with no saved connection, opens
// the link: /join shows the swarm host, and after Join it trades the code for
// the teammate's own token, saves it as a connection and lands on Home.
// Reusing the link shows the expired copy.
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
    // Admin is preselected: pick Requester.
    await expect(dialog.getByRole("radio", { name: "Admin" })).toBeChecked();
    await dialog.getByRole("radio", { name: "Requester" }).click();
    await expect(dialog.getByRole("radio", { name: "Requester" })).toBeChecked();
    await dialog.getByRole("button", { name: "Create invite link" }).click();

    await expect(dialog.getByRole("heading", { name: "Invite link ready" })).toBeVisible();
    await expect(dialog).toContainText("Anyone with this link joins as Requester.");
    await expect(dialog).toContainText("one use.");
    const link = await dialog.getByLabel("Invite link", { exact: true }).inputValue();
    const url = new URL(link);
    expect(url.pathname).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(url.search).toBe("");
    await expect(dialog).toContainText(`Opens ${new URL(page.url()).host}`);
    await expect(dialog.getByRole("button", { name: "Use this dashboard" })).toHaveCount(0);

    const teammate = await browser.newContext(FRESH_BROWSER);
    try {
      const ada = await teammate.newPage();
      const dashboardRequests: URL[] = [];
      ada.on("request", (request) => {
        const requested = new URL(request.url());
        if (requested.origin === new URL(page.url()).origin) dashboardRequests.push(requested);
      });
      await ada.goto(link);
      // Nothing is saved before the teammate confirms the host.
      await expect(ada.getByRole("button", { name: "Join swarm" })).toBeVisible();
      expect(await ada.evaluate(() => localStorage.getItem("agent-swarm-connections"))).toBeNull();
      await ada.getByRole("button", { name: "Join swarm" }).click();
      await ada.waitForURL((current) => current.pathname === "/");
      // The code left the address bar.
      expect(new URL(ada.url()).searchParams.get("code")).toBeNull();
      expect(new URL(ada.url()).hash).toBe("");
      expect(dashboardRequests.some((requested) => requested.pathname === "/join")).toBe(true);
      expect(dashboardRequests.every((requested) => !requested.searchParams.has("code"))).toBe(
        true,
      );
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
      await reuse.getByRole("button", { name: "Join swarm" }).click();
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

  test("an admin changes the destination for an existing link", async ({ page, api }) => {
    await page.goto("/people");
    const dashboard = new URL(page.url()).origin;
    await api.put("/api/config", {
      scope: "global",
      key: "APP_URL",
      value: "https://other.example.com",
    });
    try {
      await page.goto("/people");
      await page.getByRole("button", { name: "Invite", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Email").fill("e2e-destination@example.com");
      await dialog.getByRole("button", { name: "Create invite link" }).click();
      await expect(dialog).toContainText("Opens other.example.com");
      await expect(dialog).toContainText(
        "Teammates land on https://other.example.com, not on this dashboard.",
      );
      const link = await dialog.getByLabel("Invite link", { exact: true }).inputValue();
      await dialog.getByRole("button", { name: "Use this dashboard" }).click();
      await expect(dialog.getByRole("status")).toHaveText(
        "Saved. The link now opens this dashboard.",
      );
      await expect(dialog.getByLabel("Invite link", { exact: true })).toHaveValue(link);
      await expect(dialog).toContainText(`Opens ${new URL(dashboard).host}`);
      const response = await page.request.get(link, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(new URL(response.headers().location).origin).toBe(dashboard);
    } finally {
      await api.put("/api/config", { scope: "global", key: "APP_URL", value: dashboard });
    }
  });
});
