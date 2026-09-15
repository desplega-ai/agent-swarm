import type { TaskAttachment } from "../../../apps/ui/src/api/types";
import { expect, test } from "../fixtures";

test("prompt attachment links open viewers and keep downloads separate", async ({
  page,
  api,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const task = await api.post<{ id: string }>("/api/tasks", {
    task: "Review these attached files",
    source: "ui",
    requestedByUserId: seed!.user.id,
    status: "draft",
  });
  const base = {
    taskId: task.id,
    agentId: null,
    createdAt: new Date().toISOString(),
    isPrimary: false,
  };
  const attachments: TaskAttachment[] = [
    {
      ...base,
      id: "scorecard",
      kind: "agent-fs",
      name: "HOL check-level scorecard",
      path: "reports/hol-scorecard.md",
      orgId: "e2e-org",
      driveId: "e2e-drive",
      sizeBytes: 24678,
    },
    {
      ...base,
      id: "pdf",
      kind: "agent-fs",
      name: "Quarterly report",
      path: "reports/quarterly.pdf",
      orgId: "e2e-org",
      driveId: "e2e-drive",
      mimeType: "application/pdf",
    },
    { ...base, id: "url", kind: "url", name: "Reference", url: "https://example.com/reference" },
    { ...base, id: "page", kind: "page", name: "Published report", pageId: "e2e-page" },
    { ...base, id: "shared", kind: "shared-fs", name: "Local archive", path: "archive.bin" },
    { ...base, id: "text", kind: "shared-fs", name: "notes.txt", path: "notes.txt" },
    { ...base, id: "unscoped", kind: "agent-fs", name: "Unscoped file", path: "report" },
    {
      ...base,
      id: "image",
      kind: "agent-fs",
      name: "diagram.png",
      mimeType: "image/png",
      path: "diagram.png",
      orgId: "e2e-org",
      driveId: "e2e-drive",
    },
  ];
  await page.route(`**/api/fs/tasks/${task.id}/files`, (route) =>
    route.fulfill({ json: { attachments } }),
  );
  const rawRequests: string[] = [];
  await page.route(`**/api/fs/tasks/${task.id}/files/*/raw`, (route) => {
    const id = route.request().url().split("/").at(-2)!;
    rawRequests.push(id);
    return route.fulfill(
      id === "image"
        ? {
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            ),
          }
        : {
            contentType: id === "text" ? "text/plain" : "application/octet-stream",
            body: "Attachment content",
          },
    );
  });
  // Keep the test on local fixtures even when the primary action opens a new tab.
  await page
    .context()
    .route("https://live.agent-fs.dev/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<h1>File viewer</h1>" }),
    );
  await page.goto(`/sessions/${task.id}`);
  const prompt = page.getByRole("region", { name: "Prompt attachments" });
  await expect(prompt.getByText("Agent FS · 24.1 KB")).toBeVisible();
  await expect(prompt.getByText("Agent FS · PDF")).toBeVisible();
  await expect(prompt.getByText("hol-scorecard.md")).toBeVisible();

  for (const [name, href] of [
    [
      "HOL check-level scorecard",
      "https://live.agent-fs.dev/file/~/e2e-org/e2e-drive/reports/hol-scorecard.md",
    ],
    [
      "Quarterly report",
      "https://live.agent-fs.dev/file/~/e2e-org/e2e-drive/reports/quarterly.pdf",
    ],
    ["Reference", "https://example.com/reference"],
    ["Published report", "/pages/e2e-page"],
  ]) {
    const link = prompt.getByRole("link", { name: `Open ${name} in a new tab` });
    await expect(link).toHaveAttribute("href", href);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link.locator(".lucide-external-link")).toBeVisible();
    await expect(link.locator("button")).toHaveCount(0);
  }
  const popupPromise = page.waitForEvent("popup");
  await prompt.getByRole("link", { name: "Open HOL check-level scorecard in a new tab" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "File viewer" })).toBeVisible();
  await popup.close();
  expect(rawRequests.filter((id) => id !== "image")).toEqual([]);

  for (const name of ["HOL check-level scorecard", "Local archive", "Unscoped file"]) {
    const downloadPromise = page.waitForEvent("download");
    await prompt.getByRole("button", { name: `Download ${name}`, exact: true }).click();
    expect((await downloadPromise).suggestedFilename()).toBe(name);
  }
  expect(rawRequests).toEqual(expect.arrayContaining(["scorecard", "shared", "unscoped"]));

  await prompt.getByRole("button", { name: "Expand notes.txt preview" }).click();
  await expect(page.getByRole("dialog").getByText("Attachment content")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(prompt.getByRole("img", { name: "diagram.png" })).toBeVisible();
  await prompt.getByRole("button", { name: "Expand diagram.png preview" }).click();
  await expect(page.getByRole("dialog").getByRole("img", { name: "diagram.png" })).toBeVisible();
  await clean.assertClean();
});
