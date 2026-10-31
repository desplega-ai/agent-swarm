import { expect, test } from "../fixtures";

for (const width of [1280, 390]) {
  for (const legacy of [false, true]) {
    test(`create task transfers an unsent draft at ${width}px (${legacy ? "legacy" : "v2"})`, async ({
      page,
      seed,
      clean,
    }) => {
      test.skip(!seed, "remote run without seed");
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/sessions?legacy=${legacy ? "1" : "0"}`);
      await expect(page).not.toHaveURL(/legacy=/);
      await page.goto("/tasks?new=true");
      const dialog = page.getByRole("dialog", { name: "Create task" });
      const prompt = "Review the auth flow\nKeep this draft unsent. & # + café";
      const creates: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") {
          creates.push(request.postData() ?? "");
        }
      });
      await dialog.getByRole("textbox", { name: "Task description" }).fill(prompt);
      await expect(dialog.getByLabel("Task type", { exact: true })).not.toBeVisible();
      await dialog.getByRole("button", { name: "Advanced settings" }).click();
      await expect(dialog.getByLabel("Task type", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Start as a session" }).click();
      const composer = page.getByPlaceholder("What's the goal?");
      await expect(composer).toHaveValue(prompt);
      await expect(page).not.toHaveURL(/seed=/);
      await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeVisible();
      expect(creates).toEqual([]);
      await clean.assertClean();
    });
  }
}

test("create task keeps advanced settings when collapsed and submits them", async ({
  page,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  await page.goto("/tasks?new=true");
  const dialog = page.getByRole("dialog", { name: "Create task" });
  await dialog.getByRole("textbox", { name: "Task description" }).fill("e2e custom task creation");
  await dialog.getByRole("combobox", { name: "Assign to agent" }).click();
  await page.getByRole("option", { name: "e2e-worker-a", exact: true }).click();
  await dialog.getByRole("button", { name: "Advanced settings" }).click();
  await dialog.getByLabel("Task type", { exact: true }).fill("research");
  await dialog.getByLabel("Priority (0–100)", { exact: true }).fill("77");
  await dialog.getByLabel("Tags (comma-separated)").fill("feature, urgent");
  await dialog.getByLabel("Model tier", { exact: true }).click();
  await page.getByRole("option", { name: /Smart/ }).click();
  await dialog.getByLabel("Dependencies", { exact: true }).fill("e2e pending lead task");
  await dialog.getByRole("button", { name: /e2e pending lead task/ }).click();
  await dialog.getByRole("button", { name: "Advanced settings" }).click();
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  const created = await response;
  expect(created.ok()).toBe(true);
  expect(created.request().postDataJSON()).toMatchObject({
    task: "e2e custom task creation",
    agentId: seed!.agents.workerA,
    routingReason: "human_pinned",
    taskType: "research",
    priority: 77,
    tags: ["feature", "urgent"],
    modelTier: "smart",
    dependsOn: [seed!.tasks.pendingLead],
  });
  await expect(dialog).not.toBeVisible();
  await clean.assertClean();
});

test("failed task creation keeps the draft for retry", async ({ page, seed }) => {
  test.skip(!seed, "remote run without seed");
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 503, json: { error: "Task creation unavailable" } });
  });
  await page.goto("/tasks?new=true");
  const dialog = page.getByRole("dialog", { name: "Create task" });
  await dialog.getByRole("textbox", { name: "Task description" }).fill("Keep this task draft");
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Task creation unavailable");
  await expect(dialog.getByRole("textbox", { name: "Task description" })).toHaveValue(
    "Keep this task draft",
  );
  await expect(dialog.getByRole("button", { name: "Create task", exact: true })).toBeEnabled();
});
