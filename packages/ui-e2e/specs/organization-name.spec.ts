import { expect, test } from "../fixtures";

test.describe("organization name onboarding", () => {
  test.afterEach(async ({ api }) => {
    await api.put("/api/config", {
      scope: "global",
      key: "SWARM_ORG_NAME",
      value: "e2e organization",
      isSecret: false,
    });
    await api.post("/api/config/reload", {});
  });

  test.beforeEach(async ({ api }) => {
    await api.put("/api/config", {
      scope: "global",
      key: "SWARM_ORG_NAME",
      value: "",
      isSecret: false,
    });
    await api.post("/api/config/reload", {});
  });

  test("asks for an unset name, persists the trimmed submission, and stays closed after reload", async ({
    page,
    api,
    clean,
    swarm,
  }) => {
    const existing = await api.get<{ configs: Array<{ id: string; key: string }> }>(
      "/api/config?scope=global",
    );
    const nameConfig = existing.configs.find((row) => row.key === "SWARM_ORG_NAME");
    expect(nameConfig).toBeDefined();
    const deleted = await page.request.delete(`${swarm.apiUrl}/api/config/${nameConfig?.id}`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
    });
    expect(deleted.ok()).toBe(true);
    await api.post("/api/config/reload", {});
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "Name your organization" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save organization name" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Organization name" }).fill("   ");
    await expect(dialog.getByRole("button", { name: "Save organization name" })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Organization name" }).fill("  Acme Engineering  ");
    await dialog.getByRole("button", { name: "Save organization name" }).click();
    await expect(dialog).not.toBeVisible();
    const { configs } = await api.get<{ configs: Array<{ key: string; value: string }> }>(
      "/api/config?scope=global",
    );
    expect(configs.find((row) => row.key === "SWARM_ORG_NAME")?.value).toBe("Acme Engineering");
    const status = await api.get<{ identity: { name: string } }>("/status");
    expect(status.identity.name).toBe("Acme Engineering");
    await page.reload();
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await clean.assertClean();
  });

  test("treats whitespace as unset and allows deferring until the next visit", async ({
    page,
    api,
  }) => {
    await api.put("/api/config", {
      scope: "global",
      key: "SWARM_ORG_NAME",
      value: " \t ",
      isSecret: false,
    });
    await api.post("/api/config/reload", {});
    const result = await api.get<{ presence: Record<string, boolean> }>(
      "/api/config/env-presence?keys=SWARM_ORG_NAME",
    );
    expect(result.presence.SWARM_ORG_NAME).toBe(false);
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "Name your organization" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Later" }).click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await expect(dialog).toBeVisible();
  });

  test("keeps an explicitly configured Swarm name", async ({ page, api, clean }) => {
    await api.put("/api/config", {
      scope: "global",
      key: "SWARM_ORG_NAME",
      value: "Swarm",
      isSecret: false,
    });
    await api.post("/api/config/reload", {});
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Name your organization" })).not.toBeVisible();
    await clean.assertClean();
  });

  test("waits for fresh presence when a cached missing name has since been configured", async ({
    page,
    api,
  }) => {
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "Name your organization" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Later" }).click();
    await page.waitForFunction(() => {
      const cache = JSON.parse(localStorage.getItem("agent-swarm-query-cache-v1") ?? "{}");
      return cache.clientState?.queries?.some(
        (query: { queryKey: string[]; state: { data?: Record<string, boolean> } }) =>
          query.queryKey[1] === "env-presence" && query.state.data?.SWARM_ORG_NAME === false,
      );
    });
    await api.put("/api/config", {
      scope: "global",
      key: "SWARM_ORG_NAME",
      value: "Acme",
      isSecret: false,
    });
    await api.post("/api/config/reload", {});
    let releasePresence: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releasePresence = resolve;
    });
    await page.route("**/api/config/env-presence?**", async (route) => {
      await released;
      await route.continue();
    });
    await page.reload();
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(dialog).not.toBeVisible();
    const refreshed = page.waitForResponse((response) =>
      response.url().includes("/api/config/env-presence?"),
    );
    releasePresence?.();
    await refreshed;
    await expect(dialog).not.toBeVisible();
  });

  for (const response of [
    { status: 404, body: "Not found" },
    { status: 200, body: JSON.stringify({ presence: {} }) },
  ]) {
    test(`unsupported presence (${response.status}) leaves dashboard usable`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/config/env-presence?**", (route) =>
        route.fulfill({ ...response, contentType: "application/json" }),
      );
      await page.goto("/");
      await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Name your organization" })).not.toBeVisible();
      await page.goto("/settings/configuration");
      await expect(page.getByRole("switch", { name: "Enable steering" })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("save failure remains retryable and dismissible", async ({ page }) => {
    await page.route("**/api/config/reload", (route) =>
      route.fulfill({ status: 404, body: "Not found" }),
    );
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "Name your organization" });
    await dialog.getByRole("textbox", { name: "Organization name" }).fill("Acme");
    await dialog.getByRole("button", { name: "Save organization name" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Could not apply your organization name. Please try again.",
    );
    await expect(dialog.getByRole("button", { name: "Save organization name" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Later" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
