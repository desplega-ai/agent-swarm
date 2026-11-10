import { expect, test } from "../fixtures";

interface ConfigRow {
  id: string;
  key: string;
  scope: string;
  value: string;
}

test("script executor selection persists and resets to native", async ({
  page,
  api,
  clean,
  seed,
}) => {
  test.skip(!seed, "remote run without seed");
  // Groups start collapsed; a search opens every group with a hit.
  await page.goto("/settings/configuration?search=SCRIPT_EXECUTOR");
  const executor = page.locator("#setting-SCRIPT_EXECUTOR").getByRole("combobox");
  await expect(executor).toHaveText("Default (native)");

  try {
    await executor.click();
    await page.getByRole("option", { name: "quickjs", exact: true }).click();
    await expect(page.getByText("Saved SCRIPT_EXECUTOR", { exact: true })).toBeVisible();
    await page.reload();
    await expect(executor).toHaveText("quickjs");
    const saved = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    expect(saved.configs.find((config) => config.key === "SCRIPT_EXECUTOR")?.value).toBe("quickjs");

    await executor.click();
    await page.getByRole("option", { name: "Default (native)", exact: true }).click();
    await expect(page.getByText("Reset SCRIPT_EXECUTOR to its default")).toBeVisible();
    await expect(executor).toHaveText("Default (native)");
    const reset = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    expect(reset.configs.some((config) => config.key === "SCRIPT_EXECUTOR")).toBe(false);
  } finally {
    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    const config = configs.find((entry) => entry.key === "SCRIPT_EXECUTOR");
    if (config) await api.delete(`/api/config/${config.id}`);
  }

  await clean.assertClean();
});

test("file link target saves dashboard and resets to not set", async ({
  page,
  api,
  clean,
  seed,
}) => {
  test.skip(!seed, "remote run without seed");
  // Groups start collapsed; a search opens every group with a hit.
  await page.goto("/settings/configuration?search=AGENT_FS_LINK_TARGET");
  const target = page.locator("#setting-AGENT_FS_LINK_TARGET").getByRole("combobox");
  await expect(target).toHaveText("Not set");

  try {
    await target.click();
    await page.getByRole("option", { name: "dashboard", exact: true }).click();
    await expect(page.getByText("Saved AGENT_FS_LINK_TARGET", { exact: true })).toBeVisible();
    await page.reload();
    await expect(target).toHaveText("dashboard");
    const saved = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    expect(saved.configs.find((config) => config.key === "AGENT_FS_LINK_TARGET")?.value).toBe(
      "dashboard",
    );

    await target.click();
    await page.getByRole("option", { name: "Not set", exact: true }).click();
    await expect(page.getByText("Reset AGENT_FS_LINK_TARGET to its default")).toBeVisible();
    await expect(target).toHaveText("Not set");
    const reset = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    expect(reset.configs.some((config) => config.key === "AGENT_FS_LINK_TARGET")).toBe(false);
  } finally {
    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    const config = configs.find((entry) => entry.key === "AGENT_FS_LINK_TARGET");
    if (config) await api.delete(`/api/config/${config.id}`);
  }

  await clean.assertClean();
});

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
  // Groups start collapsed; a search opens every group with a hit.
  await page.goto("/settings/configuration?search=HEARTBEAT_INTERVAL_MS");
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
  // Groups start collapsed; a search opens every group with a hit.
  await page.goto("/settings/configuration?search=MEMORY_RATERS");
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

test("Slack icons distinguish disabled, custom and inherited values", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const key = "SLACK_REACTION_COMPLETED";
  const row = page.locator(`#setting-${key}`);
  const input = row.getByRole("textbox");
  const stored = async () =>
    (await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global")).configs.find(
      (entry) => entry.key === key,
    );
  try {
    await page.goto(`/settings/configuration?search=${key}`);
    await expect(row.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await stored())?.value).toBe("");
    await page.reload();
    await expect(input).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(row.getByText("No icon", { exact: true })).toHaveCount(1);
    await expect(row.getByRole("button", { name: "No icon", exact: true })).toHaveCount(0);
    await row.getByRole("button", { name: "Restore icon", exact: true }).click();
    await expect.poll(async () => (await stored())?.value).toBe("white_check_mark");
    await expect(input).toHaveValue("white_check_mark");
    await input.fill(":owl:");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await stored())?.value).toBe(":owl:");
    await row.getByRole("button", { name: "No icon", exact: true }).click();
    await expect.poll(async () => (await stored())?.value).toBe("");
    await expect(input).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Restore icon", exact: true })).toBeEnabled();
    await row.getByRole("button", { name: `Remove the saved value for ${key}` }).click();
    await expect.poll(stored).toBeUndefined();
    await expect(input).toHaveAttribute("placeholder", "Enter shortcode");
    await expect(row.getByRole("button", { name: "No icon", exact: true })).toBeEnabled();
  } finally {
    const config = await stored();
    if (config) await api.delete(`/api/config/${config.id}`);
  }
  await clean.assertClean();
});

test("Slack task tree preference persists independently of V2 and resets to On", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const key = "SLACK_RENDER_V2_TASK_TREE_ENABLED";
  await api.put("/api/config", {
    scope: "global",
    key: "SLACK_RENDER_V2",
    value: "false",
    isSecret: false,
  });
  try {
    await page.goto("/settings/configuration?search=SLACK_RENDER_V2");
    const toggle = page.getByRole("switch", {
      name: "Show task tree in Slack threads",
      exact: true,
    });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.getByText(`Saved ${key}`, { exact: true })).toBeVisible();
    await page.reload();
    await expect(toggle).not.toBeChecked();
    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    expect(configs.find((row) => row.key === key)?.value).toBe("false");
    expect(configs.find((row) => row.key === "SLACK_RENDER_V2")?.value).toBe("false");
    await page
      .getByRole("button", { name: `Remove the saved value for ${key}`, exact: true })
      .click();
    await expect(toggle).toBeChecked();
  } finally {
    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    for (const config of configs.filter(
      (row) => row.key === key || row.key === "SLACK_RENDER_V2",
    )) {
      await api.delete(`/api/config/${config.id}`);
    }
  }
  await clean.assertClean();
});
