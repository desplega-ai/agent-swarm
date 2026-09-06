import { expect, test } from "../fixtures";

interface ConfigRow {
  key: string;
  scope: string;
  value: string;
}

test("configuration flips STEERING_ENABLED and persists it", async ({ page, api, clean, seed }) => {
  test.skip(!seed, "remote run without seed");
  await page.goto("/settings/configuration");

  const steering = page.getByRole("switch", { name: "Enable steering" });
  await expect(steering).toBeVisible();
  await expect(steering).not.toBeChecked();

  try {
    await steering.click();
    await expect(page.getByText("Saved STEERING_ENABLED")).toBeVisible();

    // The reload also clears the toast, so the second save below stays the only
    // "Saved STEERING_ENABLED" node in the DOM.
    await page.reload();
    await expect(steering).toBeChecked();

    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    expect(configs.find((row) => row.key === "STEERING_ENABLED")?.value).toBe("true");

    await steering.click();
    await expect(page.getByText("Saved STEERING_ENABLED")).toBeVisible();
    await expect(steering).not.toBeChecked();
  } finally {
    // Retries reuse the worker's API, so a failed run must not leave the flag on.
    await api.put("/api/config", {
      scope: "global",
      key: "STEERING_ENABLED",
      value: "false",
      isSecret: false,
    });
  }

  await clean.assertClean();
});
