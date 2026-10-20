import type { Route } from "@playwright/test";
import { expect, test } from "../fixtures";

test.describe("organization name gate", () => {
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
    await api.put("/api/onboarding", { action: "dismiss" });
    await api.put("/api/config", {
      scope: "global",
      key: "SWARM_ORG_NAME",
      value: "",
      isSecret: false,
    });
    await api.post("/api/config/reload", {});
  });

  test("opens for an unset name, persists the trimmed submission, and stays closed after reload", async ({
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
    // The server applies the row to `/status` on its own reload, about 250 ms after the write.
    await expect
      .poll(async () => (await api.get<{ identity: { name: string } }>("/status")).identity.name)
      .toBe("Acme Engineering");
    await page.reload();
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await clean.assertClean();
  });

  test("treats whitespace as unset and cannot be closed", async ({ page, api }) => {
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
    await expect(dialog.getByRole("button", { name: "Later" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    // A reload and a fresh tab ask again: there is no deferral.
    await page.reload();
    await expect(dialog).toBeVisible();
    const freshTab = await page.context().newPage();
    await freshTab.goto("/tasks");
    await expect(freshTab.getByRole("dialog", { name: "Name your organization" })).toBeVisible();
    await freshTab.close();
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
    await page.evaluate(() => sessionStorage.clear());
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

  test("asks on a non-Home route too", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByRole("dialog", { name: "Name your organization" })).toBeVisible();
  });

  test("members never see it", async ({ page }) => {
    await page.route("**/api/users**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        json: {
          ...body,
          users: body.users.map((user: Record<string, unknown>) => ({ ...user, role: "member" })),
        },
      });
    });
    await page.goto("/tasks");
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Name your organization" })).not.toBeVisible();
  });

  // Cold: no cached profile. Cached: the persisted query cache holds a profile
  // from before the website was stored, so only the fresh read has it.
  for (const cached of [false, true]) {
    test(`waits for the stored website before it pre-fills or saves (${cached ? "cached" : "cold"} profile)`, async ({
      page,
      api,
      swarm,
    }) => {
      type Rows = { configs: Array<{ id: string; key: string; value: string }> };
      const before = new Set(
        (await api.get<Rows>("/api/config?scope=global")).configs.map((row) => row.key),
      );
      try {
        // A work email makes the email guess (acme.com) differ from the stored website.
        await page.route("**/api/users**", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          await route.fulfill({
            json: {
              ...body,
              users: body.users.map((user: Record<string, unknown>) => ({
                ...user,
                email: "admin@acme.com",
              })),
            },
          });
        });
        const dialog = page.getByRole("dialog", { name: "Name your organization" });
        if (cached) {
          await page.goto("/");
          await expect(dialog).toBeVisible();
          await page.waitForFunction(() => {
            const cache = JSON.parse(localStorage.getItem("agent-swarm-query-cache-v1") ?? "{}");
            return cache.clientState?.queries?.some(
              (query: { queryKey: [string, { scope?: string }?] }) =>
                query.queryKey[0] === "configs" && query.queryKey[1]?.scope === "global",
            );
          });
        }
        // The server also fills SWARM_ORG_LOGO_URL from the website.
        await api.put("/api/config", {
          scope: "global",
          key: "SWARM_ORG_WEBSITE",
          value: "product.com",
          isSecret: false,
        });
        let releaseConfigs: (() => void) | undefined;
        const released = new Promise<void>((resolve) => {
          releaseConfigs = resolve;
        });
        await page.route(
          (url) => url.pathname === "/api/config" && url.searchParams.get("scope") === "global",
          async (route) => {
            if (route.request().method() === "GET") await released;
            await route.continue();
          },
        );
        const presence = page.waitForResponse((response) =>
          response.url().includes("/api/config/env-presence?"),
        );
        if (cached) await page.reload();
        else await page.goto("/");
        await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
        await presence;
        // Presence reports the name missing, so only the held profile read keeps
        // the gate closed. Give the gate time to open if it would.
        await page.waitForTimeout(500);
        await expect(dialog).not.toBeVisible();
        releaseConfigs?.();
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole("textbox", { name: "Company website (optional)" }),
        ).toHaveValue("product.com");
        await dialog.getByRole("button", { name: "Save organization name" }).click();
        await expect(dialog).not.toBeVisible();
        const { configs } = await api.get<Rows>("/api/config?scope=global");
        expect(configs.find((row) => row.key === "SWARM_ORG_NAME")?.value).toBe("Product");
        expect(configs.find((row) => row.key === "SWARM_ORG_WEBSITE")?.value).toBe("product.com");
      } finally {
        const { configs } = await api.get<Rows>("/api/config?scope=global");
        for (const row of configs) {
          if (before.has(row.key)) continue;
          if (row.key !== "SWARM_ORG_WEBSITE" && row.key !== "SWARM_ORG_LOGO_URL") continue;
          const deleted = await page.request.delete(`${swarm.apiUrl}/api/config/${row.id}`, {
            headers: { Authorization: `Bearer ${swarm.apiKey}` },
          });
          expect(deleted.ok()).toBe(true);
        }
        await api.post("/api/config/reload", {});
      }
    });
  }

  test("save failure stays retryable and the dialog stays open", async ({ page }) => {
    const failUpsert = (route: Route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, json: { error: "Config store unavailable" } })
        : route.continue();
    await page.route("**/api/config?**", failUpsert);
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "Name your organization" });
    await dialog.getByRole("textbox", { name: "Organization name" }).fill("Acme");
    await dialog.getByRole("button", { name: "Save organization name" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Config store unavailable");
    await expect(dialog.getByRole("button", { name: "Save organization name" })).toBeEnabled();
    await expect(dialog).toBeVisible();
    // The retry saves and closes the dialog.
    await page.unroute("**/api/config?**", failUpsert);
    await dialog.getByRole("button", { name: "Save organization name" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
