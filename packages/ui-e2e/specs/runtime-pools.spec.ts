import { expect, test } from "../fixtures";

test("Kubernetes controllers and pools save through the dashboard @local", async ({
  page,
  api,
  clean,
}) => {
  const name = `e2e-k8s-${Date.now()}`;
  let controllerId: string | undefined;
  let poolId: string | undefined;
  await api.put("/api/config", {
    scope: "global",
    key: "RUNTIME_POOLS_ENABLED",
    value: "true",
  });
  try {
    await expect
      .poll(
        async () =>
          (await api.get<{ runtime_pools: { enabled: boolean } }>("/status")).runtime_pools.enabled,
      )
      .toBe(true);
    await page.goto("/settings/runtime-pools/controllers");
    await page.getByRole("button", { name: "New controller", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: false }).fill(name);
    await dialog.getByRole("combobox", { name: "Provider", exact: true }).click();
    await page.getByRole("option", { name: "Kubernetes", exact: true }).click();
    const placement = dialog.getByRole("combobox", { name: "Placement", exact: true });
    await expect(placement).toHaveText("Built in");
    await expect(placement).toBeDisabled();
    await expect(
      dialog.getByText("Kubernetes requires a built-in controller inside the swarm API."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Add setting", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Config key 1", exact: true }).fill("K8S_NAMESPACE");
    await dialog.getByRole("textbox", { name: "Config value 1", exact: true }).fill("ui-workers");
    await dialog.getByRole("button", { name: "Add secret", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Secret key 1", exact: true }).fill("K8S_TOKEN");
    await dialog.getByLabel("Secret value 1", { exact: true }).fill("synthetic-k8s-test-token");
    const createdController = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runtime-controllers") &&
        response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Create controller", exact: true }).click();
    const { controller } = await (await createdController).json();
    controllerId = controller.id;
    expect(controller).toMatchObject({
      kind: "k8s",
      placement: "builtin",
      secretConfigKeys: ["K8S_TOKEN"],
    });
    expect(JSON.stringify(controller)).not.toContain("synthetic-k8s-test-token");
    await expect(dialog).not.toBeVisible();

    await page
      .getByRole("gridcell", { name: `${name} Kubernetes · Built in`, exact: true })
      .click();
    await expect(placement).toBeDisabled();
    await expect(dialog.getByText("Stored", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Secret value 1", { exact: true })).toHaveCount(0);
    await dialog
      .getByRole("textbox", { name: "Config value 1", exact: true })
      .fill("ui-workers-edited");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const savedController = await api.get<{
      controller: { config: Record<string, string>; secretConfigKeys: string[] };
    }>(`/api/runtime-controllers/${controllerId}`);
    expect(savedController.controller.config.K8S_NAMESPACE).toBe("ui-workers-edited");
    expect(savedController.controller.secretConfigKeys).toEqual(["K8S_TOKEN"]);

    await page.goto("/settings/runtime-pools/new");
    await page.getByRole("textbox", { name: "Name", exact: false }).fill(name);
    await page.getByRole("combobox", { name: "Provider", exact: true }).click();
    await page.getByRole("option", { name: "Kubernetes", exact: true }).click();
    await page.getByRole("combobox", { name: "Controller", exact: true }).click();
    await page.getByRole("option", { name, exact: false }).click();
    await page
      .getByRole("textbox", { name: "Image", exact: true })
      .fill("ghcr.io/desplega-ai/agent-swarm-worker:slim");
    await page.getByRole("switch", { name: "Enabled", exact: true }).uncheck();
    const createdPool = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/runtime-pools") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create pool", exact: true }).click();
    const { pool } = await (await createdPool).json();
    poolId = pool.id;
    expect(pool).toMatchObject({ kind: "k8s", placements: [controllerId], enabled: false });
    await expect(page).toHaveURL(new RegExp(`/settings/runtime-pools/${poolId}$`));
    await expect(
      page.getByText("No runtimes. They appear when the pool provisions one for a bound agent."),
    ).toBeVisible();
    await page.getByLabel("Slots per runtime", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Save pool", exact: true }).click();
    await expect(page.getByText(`Saved ${name}`, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Slots per runtime", { exact: true })).toHaveValue("2");
    await clean.assertClean();
  } finally {
    await page.goto("/settings/connections");
    if (poolId) await api.delete(`/api/runtime-pools/${poolId}`);
    if (controllerId) await api.delete(`/api/runtime-controllers/${controllerId}`);
    const { configs } = await api.get<{ configs: { id: string; key: string }[] }>(
      "/api/config?scope=global",
    );
    const flag = configs.find((config) => config.key === "RUNTIME_POOLS_ENABLED");
    if (flag) await api.delete(`/api/config/${flag.id}`);
  }
});
