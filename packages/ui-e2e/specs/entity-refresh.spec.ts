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
    await expect(page.getByText("A newer version is available")).toBeVisible({ timeout: 40_000 });
    await expect(page.getByText("First app version")).toBeVisible();
    await page.getByRole("button", { name: "Load latest" }).click();
    await expect(page.getByText("Second app version")).toBeVisible();
    await expect(page.getByTestId("version-update-toast")).toHaveCount(0);
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
    await expect(page.getByText("A newer version is available")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("First workflow version").first()).toBeVisible();
    await page.getByRole("button", { name: "Load latest" }).click();
    await expect(page.getByText("Second workflow version").first()).toBeVisible();
    await expect(page.getByTestId("version-update-toast")).toHaveCount(0);
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
    await expect(page.getByText("Updated to the latest version")).toBeVisible();
    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.getByText("First auto workflow").first()).toBeVisible();
    await api.put(`/api/workflows/${workflow.id}`, {
      definition: workflowDefinition("Second auto workflow"),
    });
    await expect(page.getByText("Second auto workflow").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Updated to the latest version").first()).toBeVisible();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
    const response = await page.request.delete(`${swarm.apiUrl}/api/workflows/${workflow.id}`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
    });
    expect(response.status()).toBe(204);
  }
});

test("workflow parameter drafts are protected from external changes", async ({
  page,
  api,
  seed,
  swarm,
}) => {
  test.skip(!seed, "remote run without seed");
  const workflow = await api.post<{ id: string }>("/api/workflows", {
    name: "e2e parameter conflict",
    definition: {
      nodes: [{ id: "step", type: "script", config: { runtime: "bash", script: "echo ok" } }],
    },
    requiredParams: ["target"],
    params: { target: "initial" },
  });
  try {
    await page.goto(`/workflows/${workflow.id}`);
    await page.getByRole("tab", { name: "Setup" }).click();
    const input = page.getByLabel("target");
    await input.fill("local draft");
    await api.put(`/api/workflows/${workflow.id}`, { params: { target: "remote change" } });
    await expect(
      page.getByText("The saved parameters changed while you were editing.", { exact: false }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(input).toHaveValue("local draft");
    await expect(page.getByRole("button", { name: "Save parameters" })).toBeDisabled();
    await page.getByRole("button", { name: "Load saved parameters" }).click();
    await expect(input).toHaveValue("remote change");
  } finally {
    const response = await page.request.delete(`${swarm.apiUrl}/api/workflows/${workflow.id}`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
    });
    expect(response.status()).toBe(204);
  }
});

test("a parameter draft holds the workflow toast load action", async ({
  page,
  api,
  seed,
  swarm,
}) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(45_000);
  const definition = (label: string) => ({
    nodes: [{ id: "step", type: "script", label, config: { runtime: "bash", script: "echo ok" } }],
  });
  const workflow = await api.post<{ id: string }>("/api/workflows", {
    name: "e2e draft toast",
    definition: definition("First draft version"),
    requiredParams: ["target"],
    params: { target: "initial" },
  });
  try {
    await page.goto(`/workflows/${workflow.id}`);
    await page.getByRole("tab", { name: "Setup" }).click();
    await page.getByLabel("target").fill("local draft");
    await api.put(`/api/workflows/${workflow.id}`, {
      definition: definition("Second draft version"),
    });
    const toast = page.getByTestId("version-update-toast");
    await expect(toast).toContainText("Finish editing to load it.", { timeout: 20_000 });
    await expect(toast.getByRole("button", { name: "Load latest" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save parameters" }).click();
    await expect(toast.getByRole("button", { name: "Load latest" })).toBeVisible();
    await toast.getByRole("button", { name: "Load latest" }).click();
    await expect(toast).toHaveCount(0);
    await page.getByRole("tab", { name: "Definition" }).click();
    await expect(page.getByText("Second draft version").first()).toBeVisible();
  } finally {
    const response = await page.request.delete(`${swarm.apiUrl}/api/workflows/${workflow.id}`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
    });
    expect(response.status()).toBe(204);
  }
});

test("a dismissed version toast stays closed until a newer version", async ({
  page,
  api,
  seed,
  swarm,
}) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(60_000);
  const definition = (label: string) => ({
    nodes: [{ id: "step", type: "script", label, config: { runtime: "bash", script: "echo ok" } }],
  });
  const workflow = await api.post<{ id: string }>("/api/workflows", {
    name: "e2e dismissed toast",
    definition: definition("First dismissed version"),
  });
  try {
    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.getByText("First dismissed version").first()).toBeVisible();
    await api.put(`/api/workflows/${workflow.id}`, { definition: definition("Second dismissed") });
    const toast = page.getByTestId("version-update-toast");
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await toast.getByRole("button", { name: "Close" }).click();
    await expect(toast).toHaveCount(0);
    await api.put(`/api/workflows/${workflow.id}`, { definition: definition("Third dismissed") });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await page.goto("/workflows");
    await expect(toast).toHaveCount(0);
  } finally {
    const response = await page.request.delete(`${swarm.apiUrl}/api/workflows/${workflow.id}`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}` },
    });
    expect(response.status()).toBe(204);
  }
});

test("automatic reload confirms the new page version", async ({ page, seed, swarm }) => {
  test.skip(!seed, "remote run without seed");
  test.setTimeout(45_000);
  const headers = { Authorization: `Bearer ${swarm.apiKey}`, "X-Agent-ID": seed!.agents.lead };
  const created = await page.request.post(`${swarm.apiUrl}/api/pages`, {
    headers,
    data: { title: "e2e auto page", contentType: "text/html", body: "<h1>First page</h1>" },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  try {
    await page.goto("/settings/appearance");
    await page.getByRole("switch", { name: "Reload new versions automatically" }).check();
    await page.goto(`/pages/${id}`);
    const frame = page.frameLocator("main iframe");
    await expect(frame.getByRole("heading", { name: "First page" })).toBeVisible();
    const update = await page.request.put(`${swarm.apiUrl}/api/pages/${id}`, {
      headers,
      data: { body: "<h1>Second page</h1>" },
    });
    expect(update.status()).toBe(200);
    await expect(frame.getByRole("heading", { name: "Second page" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/^Updated to v\d+$/)).toBeVisible();
  } finally {
    const removed = await page.request.delete(`${swarm.apiUrl}/api/pages/${id}`, { headers });
    expect(removed.status()).toBe(204);
  }
});
