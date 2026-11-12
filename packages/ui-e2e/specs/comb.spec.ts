import { expect, test } from "../fixtures";

interface CombStatus {
  enabled: boolean;
  org_id: string | null;
  drive_id: string | null;
}

interface StatusBody {
  agent_fs?: { comb?: CombStatus };
}

interface ConfigRow {
  id: string;
  key: string;
}

// Comb reads the agent-fs server's /health features. The flow below needs
// agent-fs 0.18.17 or later (named keys). Run it locally with an agent-fs server, for example:
//   E2E_COMB_AGENT_FS_URL=http://localhost:7433 bun run e2e:ui -- specs/comb.spec.ts
const agentFsUrl = process.env.E2E_COMB_AGENT_FS_URL?.trim().replace(/\/+$/, "") || null;

// Both tests are @local: the config drops @local in remote mode, where a remote
// API can have Comb on and this flow must never write config into it.
test("Comb is off without agent-fs", { tag: "@local" }, async ({ page, api, swarm, clean }) => {
  const status = await api.get<StatusBody>("/status");
  expect(status.agent_fs?.comb?.enabled).toBe(false);

  // The send route answers 404 while Comb is off, before it reads the body.
  const send = await fetch(`${swarm.apiUrl}/api/comb/review-batches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${swarm.apiKey}` },
  });
  expect(send.status).toBe(404);

  await page.goto("/file");
  await expect(page.getByRole("heading", { name: "Files is off" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Configuration" })).toBeVisible();
  // The sidebar has no Files item. The header breadcrumb reads "Files" as plain text.
  await expect(page.getByRole("link", { name: /^Files\b/ })).toHaveCount(0);
  await clean.assertClean();
});

test("Comb mints a named key per browser, then comments, replies, and resolves", {
  tag: "@local",
}, async ({ page, browser, baseURL, storageState, api, swarm, clean, seed }) => {
  test.skip(
    !agentFsUrl,
    "set E2E_COMB_AGENT_FS_URL to an agent-fs 0.18.17+ server (named keys) to run this flow",
  );
  test.skip(!seed, "remote run without seed");
  const baseUrl = agentFsUrl as string;
  const userId = seed?.user.id as string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // The seeded user gets a fresh email, so this run's agent-fs account is new.
  const humanEmail = `e2e-comb-${stamp}@example.com`;
  // Keys this test sets. The finally block deletes them, so later tests on
  // this worker's API run without agent-fs again. COMB_ENABLED stays unset:
  // Comb is on by default with AGENT_FS_API_URL.
  const settings: Record<string, string> = {
    AGENT_FS_API_URL: baseUrl,
    // Each run provisions a new swarm drive with its own service account.
    AGENT_FS_REGISTER_EMAIL: `e2e-swarm-${stamp}@agent-fs.local`,
  };
  const patchUser = (body: Record<string, unknown>) =>
    fetch(`${swarm.apiUrl}/api/users/${userId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${swarm.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const before = await api.get<{ user: { email: string | null } }>(`/api/users/${userId}`);
  const secondContext = await browser.newContext({ baseURL, storageState });

  try {
    expect((await patchUser({ email: humanEmail })).ok, "the seeded user takes the email").toBe(
      true,
    );
    // The test registers the account itself only to hold its primary key: the
    // primary key lists the named keys the browsers mint (`GET /auth/keys`).
    const registered = await fetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: humanEmail }),
    });
    expect(registered.ok, "agent-fs registers the human").toBe(true);
    const human = (await registered.json()) as { apiKey: string };

    for (const [key, value] of Object.entries(settings)) {
      await api.put("/api/config", { scope: "global", key, value, isSecret: false });
    }
    await api.post("/api/config/reload", {});
    // Provisions the swarm drive, then adds the human as an editor.
    const invited = await api.post<{ status?: string; token?: string }>("/api/fs/members/invite", {
      email: humanEmail,
      role: "editor",
    });
    // agent-fs >= 0.18.19 makes an existing account accept before it joins.
    if (invited.status === "pending" && invited.token) {
      const accepted = await fetch(`${baseUrl}/invites/${invited.token}/accept`, {
        method: "POST",
        headers: { Authorization: `Bearer ${human.apiKey}` },
      });
      expect(accepted.ok, "the human accepts the swarm drive invite").toBe(true);
    }

    const comb = (await api.get<StatusBody>("/status")).agent_fs?.comb;
    expect(comb?.enabled).toBe(true);
    const drive = `${comb?.org_id}/${comb?.drive_id}`;

    const written = await fetch(`${baseUrl}/orgs/${comb?.org_id}/ops`, {
      method: "POST",
      headers: { Authorization: `Bearer ${human.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "write",
        driveId: comb?.drive_id,
        path: "/comb-e2e/notes.md",
        content: "# E2E notes\n\nFirst paragraph.\n",
      }),
    });
    expect(written.ok, "the human writes the seed file").toBe(true);

    // No key, no click: the drive lists in this browser.
    await page.goto("/file");
    await expect(page.getByRole("link", { name: /^Files\b/ })).toBeVisible();
    await expect(page.getByText("comb-e2e", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "agent-fs key" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Connected as / })).toBeVisible();

    // A second browser with only the swarm connection lists it too.
    const second = await secondContext.newPage();
    await second.goto("/file");
    await expect(second.getByText("comb-e2e", { exact: true }).first()).toBeVisible();

    // One named key per browser, listed in agent-fs.
    const keys = await fetch(`${baseUrl}/auth/keys`, {
      headers: { Authorization: `Bearer ${human.apiKey}` },
    });
    expect(keys.ok, "agent-fs lists the human's keys").toBe(true);
    const body = (await keys.json()) as
      | { keys?: { label?: string; revokedAt?: string | null }[] }
      | { label?: string; revokedAt?: string | null }[];
    const list = Array.isArray(body) ? body : (body.keys ?? []);
    const minted = list.filter((key) => key.label?.startsWith("Swarm dashboard · "));
    expect(minted).toHaveLength(2);

    await page.goto(`/file/~/${drive}/comb-e2e/notes.md`);
    await expect(page.getByRole("heading", { name: "E2E notes" })).toBeVisible();

    await page.getByRole("button", { name: "Comment on file" }).click();
    await page.getByRole("textbox", { name: "Comment on this file" }).fill("E2E file comment");
    await page.getByRole("button", { name: "Add comment", exact: true }).click();
    const thread = page.getByRole("article").filter({ hasText: "E2E file comment" });
    await expect(thread).toBeVisible();

    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await thread.getByRole("textbox", { name: "Reply" }).fill("E2E reply");
    // The opener hides while the reply box is open: this "Reply" saves the reply.
    await thread.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread.getByText("E2E reply")).toBeVisible();

    await thread.getByRole("button", { name: "Resolve" }).click();
    await expect(page.getByRole("tab", { name: "Resolved 1" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Open 0" })).toBeVisible();

    // The send tray: dismiss one comment, one file, then all; each undoes.
    const op = (body: Record<string, unknown>) =>
      fetch(`${baseUrl}/orgs/${comb?.org_id}/ops`, {
        method: "POST",
        headers: { Authorization: `Bearer ${human.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, driveId: comb?.drive_id }),
      });
    for (const path of ["/comb-e2e/a.md", "/comb-e2e/b.md"]) {
      expect((await op({ op: "write", path, content: `# ${path}\n` })).ok).toBe(true);
    }
    for (const [path, body] of [
      ["/comb-e2e/a.md", "stale one"],
      ["/comb-e2e/a.md", "stale two"],
      ["/comb-e2e/b.md", "still wanted"],
    ]) {
      expect((await op({ op: "comment-add", path, body })).ok, `comment ${body}`).toBe(true);
    }
    await page.goto(`/file/~/${drive}/comb-e2e/notes.md`);
    // The open dialog hides the page from the accessibility tree.
    const tray = page.getByRole("button", { name: /^Send \d+ to swarm$/, includeHidden: true });
    await expect(tray).toHaveAttribute("aria-label", "Send 3 to swarm");
    await tray.click();
    const dialog = page.getByRole("dialog", { name: "Send to swarm" });
    await expect(dialog.getByRole("button", { name: "Send 3" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("dismiss-1-open.png") });

    await dialog
      .getByRole("listitem")
      .filter({ hasText: "stale one" })
      .getByRole("button", { name: "Dismiss this comment" })
      .click();
    await expect(dialog.getByRole("button", { name: "Send 2" })).toBeVisible();
    await expect(tray).toHaveAttribute("aria-label", "Send 2 to swarm");
    await expect(dialog.getByText("1 dismissed.")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("dismiss-2-one.png") });
    await dialog.getByRole("button", { name: "Undo" }).click();
    await expect(dialog.getByRole("button", { name: "Send 3" })).toBeVisible();

    await dialog.getByRole("button", { name: "Dismiss the comments on /comb-e2e/a.md" }).click();
    await expect(dialog.getByRole("button", { name: "Send 1" })).toBeVisible();
    await expect(tray).toHaveAttribute("aria-label", "Send 1 to swarm");
    await dialog.getByRole("button", { name: "Show" }).click();
    await expect(dialog.getByRole("list", { name: "Dismissed comments" })).toContainText(
      "stale two",
    );
    await page.screenshot({ path: test.info().outputPath("dismiss-3-file.png") });

    await dialog.getByRole("button", { name: "Dismiss all" }).click();
    await expect(dialog.getByText("Nothing left to send.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send 0" })).toBeDisabled();
    // With nothing left to send, the tray keeps a way back to the dismissed ones.
    await expect(tray).toHaveCount(0);
    const dismissedTray = page.getByRole("button", {
      name: /^Show \d+ dismissed comments$/,
      includeHidden: true,
    });
    await expect(dismissedTray).toHaveAttribute("aria-label", "Show 3 dismissed comments");
    await page.screenshot({ path: test.info().outputPath("dismiss-4-all.png") });
    const dismissedList = dialog.getByRole("list", { name: "Dismissed comments" });
    const restoreIn = (text: string) =>
      dismissedList
        .getByRole("listitem")
        .filter({ hasText: text })
        .getByRole("button", { name: "Restore" });

    // Dismiss all, close, reopen: the dismissed list opens and restores.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await dismissedTray.click();
    await expect(dismissedList).toContainText("stale two");
    await page.screenshot({ path: test.info().outputPath("dismiss-5-reopen.png") });
    await restoreIn("still wanted").click();
    await expect(tray).toHaveAttribute("aria-label", "Send 1 to swarm");
    await expect(dialog.getByRole("button", { name: "Send 1" })).toBeVisible();

    // Dismissing the last file's comments, then reloading, keeps the way back too.
    await dialog.getByRole("button", { name: "Dismiss the comments on /comb-e2e/b.md" }).click();
    await expect(dismissedTray).toHaveAttribute("aria-label", "Show 3 dismissed comments");
    await page.reload();
    await expect(dismissedTray).toHaveAttribute("aria-label", "Show 3 dismissed comments");
    await expect(tray).toHaveCount(0);
    await dismissedTray.click();
    await restoreIn("stale one").click();
    await expect(tray).toHaveAttribute("aria-label", "Send 1 to swarm");

    // Dismissing the last comment by its own X, then Undo.
    await dialog
      .getByRole("listitem")
      .filter({ hasText: "stale one" })
      .getByRole("button", { name: "Dismiss this comment" })
      .click();
    await expect(dismissedTray).toHaveAttribute("aria-label", "Show 3 dismissed comments");
    await dialog.getByRole("button", { name: "Undo" }).click();
    await expect(tray).toHaveAttribute("aria-label", "Send 1 to swarm");

    // Sending the rest leaves the dismissed ones unsent and reachable.
    await dialog.getByRole("button", { name: "Send 1" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(dismissedTray).toHaveAttribute("aria-label", "Show 2 dismissed comments");
    await expect(tray).toHaveCount(0);

    await clean.assertClean();
  } finally {
    await secondContext.close();
    await patchUser({ email: before.user.email });
    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    for (const row of configs.filter((config) => config.key in settings)) {
      await api.delete(`/api/config/${row.id}`);
    }
    await api.post("/api/config/reload", {});
  }
});
