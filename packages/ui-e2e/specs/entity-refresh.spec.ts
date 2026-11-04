import { expect, test } from "../fixtures";

test("app definition updates wait for the viewer", async ({ page, api, seed }) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(60_000);
  const definition = (text: string) => ({
    models: {},
    queries: {},
    pages: {
      main: { root: "text", elements: { text: { type: "Text", props: { content: text } } } },
    },
    defaultPage: "main",
  });
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e refresh app",
    definition: definition("First app version"),
  });
  try {
    await page.goto(`/apps/${app.id}`);
    await expect(page.getByText("First app version")).toBeVisible();
    await api.put(`/api/apps/${app.id}`, { definition: definition("Second app version") });
    await expect(page.getByText("A new version is available.")).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText("First app version")).toBeVisible();
    await page.getByRole("button", { name: "Load new version" }).click();
    await expect(page.getByText("Second app version")).toBeVisible();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});

test("workflow definition updates wait for the viewer", async ({ page, api, seed, swarm }) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(45_000);
  const definition = (label: string) => ({
    nodes: [{ id: "step", type: "script", label, config: { runtime: "bash", script: "echo ok" } }],
  });
  const workflow = await api.post<{ id: string }>("/api/workflows", {
    name: "e2e refresh workflow",
    definition: definition("First workflow version"),
  });
  try {
    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.getByText("First workflow version").first()).toBeVisible();
    await api.put(`/api/workflows/${workflow.id}`, {
      definition: definition("Second workflow version"),
    });
    await expect(page.getByText("A new version is available.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("First workflow version").first()).toBeVisible();
    await page.getByRole("button", { name: "Load new version" }).click();
    await expect(page.getByText("Second workflow version").first()).toBeVisible();
  } finally {
    const response = await page.request.delete(`${swarm.apiUrl}/api/workflows/${workflow.id}`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
    });
    expect(response.status()).toBe(204);
  }
});

test("automatic reload applies app and workflow updates", async ({ page, api, seed, swarm }) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(90_000);
  const appDefinition = (content: string) => ({
    models: {},
    queries: {},
    pages: { main: { root: "text", elements: { text: { type: "Text", props: { content } } } } },
    defaultPage: "main",
  });
  const workflowDefinition = (label: string) => ({
    nodes: [{ id: "step", type: "script", label, config: { runtime: "bash", script: "echo ok" } }],
  });
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e automatic refresh",
    definition: appDefinition("First auto app"),
  });
  const workflow = await api.post<{ id: string }>("/api/workflows", {
    name: "e2e automatic workflow",
    definition: workflowDefinition("First auto workflow"),
  });
  try {
    await page.goto("/settings/appearance");
    await page.getByRole("switch", { name: "Reload new versions automatically" }).check();
    await page.goto(`/apps/${app.id}`);
    await expect(page.getByText("First auto app")).toBeVisible();
    await api.put(`/api/apps/${app.id}`, { definition: appDefinition("Second auto app") });
    await expect(page.getByText("Second auto app")).toBeVisible({ timeout: 40_000 });
    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.getByText("First auto workflow").first()).toBeVisible();
    await api.put(`/api/workflows/${workflow.id}`, {
      definition: workflowDefinition("Second auto workflow"),
    });
    await expect(page.getByText("Second auto workflow").first()).toBeVisible({ timeout: 20_000 });
  } finally {
    await api.delete(`/api/apps/${app.id}`);
    const response = await page.request.delete(`${swarm.apiUrl}/api/workflows/${workflow.id}`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
    });
    expect(response.status()).toBe(204);
  }
});
