import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

// The inbound handoff from the agent-swarm.dev connector: the connector opens
// /connect?return_to=<its /connections page>; this tab mints a single-use code
// and navigates back. The connector origin is stubbed so the redirect lands on
// a page the test controls, and the code is then exchanged like the connector
// does it (no auth).
const CONNECTOR_PAGE = "https://mcp.agent-swarm.dev/connections";
const PUBLIC_ORIGIN = "https://swarm-e2e.example.com";
const CONNECT_PATH = `/connect?return_to=${encodeURIComponent(CONNECTOR_PAGE)}&client=chatgpt`;

type ConfigRow = { id: string; key: string };

async function stubConnector(page: Page): Promise<void> {
  await page.route("https://mcp.agent-swarm.dev/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<main>connector stub</main>" }),
  );
}

test.describe("/connect", () => {
  test.describe.configure({ mode: "serial" });

  test.afterEach(async ({ api }) => {
    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    const row = configs.find((config) => config.key === "PUBLIC_MCP_BASE_URL");
    if (row) await api.delete(`/api/config/${row.id}`);
  });

  test("refuses a return_to that is not on the allowlist", async ({ page }) => {
    await page.goto(
      `/connect?return_to=${encodeURIComponent("https://evil.example.com/connections")}`,
    );
    await expect(page.getByText("This connect link is not from agent-swarm.dev")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create and continue" })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/connect");
  });

  test("picks a user, mints a code, redirects back, and remembers the user", async ({
    page,
    api,
    swarm,
  }) => {
    await api.put("/api/config", {
      scope: "global",
      key: "PUBLIC_MCP_BASE_URL",
      value: PUBLIC_ORIGIN,
      isSecret: false,
    });
    const name = `Connect E2E ${Date.now()}`;
    const { user } = await api.post<{ user: { id: string } }>("/api/users", { name });
    // Forget the dashboard identity so the people picker shows.
    await page.addInitScript(
      (key) => window.localStorage.removeItem(key),
      `swarm:v1:${swarm.apiUrl}:current-user`,
    );
    await stubConnector(page);

    await page.goto(CONNECT_PATH);
    await expect(page.getByText("Who are you?")).toBeVisible();
    await page.getByPlaceholder("Search people…").fill(name);
    await page.getByRole("option", { name: new RegExp(name) }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Create a token for ${name}`);
    await expect(dialog).toContainText("mcp.agent-swarm.dev");
    await dialog.getByRole("button", { name: "Create and continue" }).click();

    await page.waitForURL((url) => url.origin === "https://mcp.agent-swarm.dev");
    const landed = new URL(page.url());
    expect(landed.pathname).toBe("/connections");
    expect(landed.searchParams.get("swarm")).toBe(PUBLIC_ORIGIN);
    expect(landed.searchParams.get("client")).toBe("chatgpt");
    const code = landed.searchParams.get("code") ?? "";
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const exchange = await page.request.post(`${swarm.apiUrl}/api/connector/exchange`, {
      data: { code },
    });
    expect(exchange.status()).toBe(200);
    const exchanged = (await exchange.json()) as { token: string; userId: string };
    expect(exchanged.userId).toBe(user.id);
    expect(exchanged.token.startsWith("aswt_")).toBe(true);
    const replay = await page.request.post(`${swarm.apiUrl}/api/connector/exchange`, {
      data: { code },
    });
    expect(replay.status()).toBe(404);

    // Second visit: the remembered user opens the confirm step without a click.
    await page.goto(CONNECT_PATH);
    await expect(page.getByRole("dialog")).toContainText(`Create a token for ${name}`);
  });

  test("shows the swarm's 400 with a settings link and stays on the page", async ({
    page,
    api,
    swarm,
  }) => {
    // Loopback http passes for local stacks; any other http origin is refused.
    await api.put("/api/config", {
      scope: "global",
      key: "PUBLIC_MCP_BASE_URL",
      value: "http://swarm-e2e.example.com",
      isSecret: false,
    });
    const name = `Connect E2E 400 ${Date.now()}`;
    const { user } = await api.post<{ user: { id: string } }>("/api/users", { name });
    await page.addInitScript(([key, id]) => window.localStorage.setItem(key, id), [
      `swarm:v1:${swarm.apiUrl}:current-user`,
      user.id,
    ] as const);
    await stubConnector(page);

    await page.goto(CONNECT_PATH);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Create a token for ${name}`);
    await dialog.getByRole("button", { name: "Create and continue" }).click();
    await expect(dialog).toContainText("is not HTTPS");
    await expect(dialog.getByRole("link", { name: "Open connection settings" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/connect");
  });
});
