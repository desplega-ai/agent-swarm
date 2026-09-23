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

test("duration units save native values and blank resets the setting", async ({
  page,
  api,
  seed,
}) => {
  test.skip(!seed, "remote run without seed");
  await api.put("/api/config", {
    scope: "global",
    key: "HEARTBEAT_INTERVAL_MS",
    value: "600000",
    isSecret: false,
  });
  await page.goto("/settings/configuration");
  const row = page.locator("#setting-HEARTBEAT_INTERVAL_MS");
  const amount = row.getByRole("spinbutton");
  await expect(amount).toHaveValue("10");
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: "s", exact: true }).click();
  await expect(amount).toHaveValue("600");
  await expect(row.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await amount.fill("1.5");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved HEARTBEAT_INTERVAL_MS", { exact: true })).toBeVisible();
  const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
  expect(configs.find((config) => config.key === "HEARTBEAT_INTERVAL_MS")?.value).toBe("1500");
  await expect(row.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.reload();
  await row.getByRole("combobox").click();
  await page.getByRole("option", { name: "ms", exact: true }).click();
  await expect(amount).toHaveValue("1500");
  await amount.fill("");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Reset HEARTBEAT_INTERVAL_MS to its default")).toBeVisible();
  const reset = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
  expect(reset.configs.some((config) => config.key === "HEARTBEAT_INTERVAL_MS")).toBe(false);
});

test("multi-select can save no raters and preserves unknown saved names", async ({
  page,
  api,
  seed,
}) => {
  test.skip(!seed, "remote run without seed");
  await api.put("/api/config", {
    scope: "global",
    key: "MEMORY_RATERS",
    value: "llm,future-rater",
    isSecret: false,
  });
  await page.goto("/settings/configuration");
  const row = page.locator("#setting-MEMORY_RATERS");
  await row.getByRole("button", { name: "Active memory raters", exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "future-rater (unrecognized)" }),
  ).toBeChecked();
  await page.getByRole("menuitemcheckbox", { name: "llm", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "future-rater (unrecognized)" }).click();
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved MEMORY_RATERS", { exact: true })).toBeVisible();
  const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
  expect(configs.find((config) => config.key === "MEMORY_RATERS")?.value).toBe("");
  await page.reload();
  await expect(row.getByText("None selected", { exact: true })).toBeVisible();
});
