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
// agent-fs 0.15.0 or later. Run it locally with an agent-fs server, for example:
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
  await expect(page.getByRole("heading", { name: "Comb is off" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Configuration" })).toBeVisible();
  // The sidebar has no Comb item. The header breadcrumb reads "Comb" as plain text.
  await expect(page.getByRole("link", { name: /^Comb\b/ })).toHaveCount(0);
  await clean.assertClean();
});

test("Comb connects, comments, replies, and resolves on agent-fs", { tag: "@local" }, async ({
  page,
  api,
  clean,
  seed,
}) => {
  test.skip(
    !agentFsUrl,
    "set E2E_COMB_AGENT_FS_URL to an agent-fs 0.15.0+ server to run this flow",
  );
  test.skip(!seed, "remote run without seed");
  const baseUrl = agentFsUrl as string;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const humanEmail = `e2e-comb-${stamp}@example.com`;
  // Keys this test sets. The finally block deletes them, so later tests on
  // this worker's API run without agent-fs again.
  const settings: Record<string, string> = {
    AGENT_FS_API_URL: baseUrl,
    // Each run provisions a new swarm drive with its own service account.
    AGENT_FS_REGISTER_EMAIL: `e2e-swarm-${stamp}@agent-fs.local`,
    COMB_ENABLED: "true",
  };

  try {
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
    await api.post("/api/fs/members/invite", { email: humanEmail, role: "editor" });

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

    await page.goto("/file");
    await expect(page.getByRole("link", { name: /^Comb\b/ })).toBeVisible();
    await page.getByRole("tab", { name: "Paste a key" }).click();
    await page.getByRole("textbox", { name: "agent-fs key" }).fill(human.apiKey);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(`Connected as ${humanEmail}`)).toBeVisible();

    await page.goto(`/file/~/${drive}/comb-e2e/notes.md`);
    await expect(page.getByRole("heading", { name: "E2E notes" })).toBeVisible();

    await page.getByRole("button", { name: "Comment on file" }).click();
    await page.getByRole("textbox", { name: "Comment on this file" }).fill("E2E file comment");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const thread = page.getByRole("article").filter({ hasText: "E2E file comment" });
    await expect(thread).toBeVisible();

    await thread.getByRole("button", { name: "Reply" }).click();
    await thread.getByRole("textbox", { name: "Reply" }).fill("E2E reply");
    await thread.getByRole("button", { name: "Send", exact: true }).click();
    await expect(thread.getByText("E2E reply")).toBeVisible();

    await thread.getByRole("button", { name: "Resolve" }).click();
    await expect(page.getByRole("tab", { name: "Resolved 1" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Open 0" })).toBeVisible();

    await clean.assertClean();
  } finally {
    const { configs } = await api.get<{ configs: ConfigRow[] }>("/api/config?scope=global");
    for (const row of configs.filter((config) => config.key in settings)) {
      await api.delete(`/api/config/${row.id}`);
    }
    await api.post("/api/config/reload", {});
  }
});
