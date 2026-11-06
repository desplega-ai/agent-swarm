import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures";

test("home renders", async ({ page, clean }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  await clean.assertClean();
});

test("home shows the post-onboarding checklist defaults", async ({ page, clean }) => {
  await page.goto("/");
  // "Getting started" once the status loads (Set up + Get the swarm working).
  const card = page.getByRole("region", { name: /^(Getting started|Get the swarm working)$/ });
  await expect(card).toBeVisible();
  for (const label of [
    "Connect a chat channel",
    "Connect work tools",
    "Plan your first use case",
  ]) {
    await expect(card.getByText(label, { exact: true })).toBeVisible();
  }
  await clean.assertClean();
});

test("home lists what needs you, the starred group with its running count, and badges Home", async ({
  page,
  seed,
  swarm,
  api,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const userId = seed!.user.id;
  const suffix = randomUUID().slice(0, 8);
  const groupName = `e2e-home-${suffix}`;
  const groupKey = `shared/${groupName}/`;
  const call = async (method: string, path: string, body?: unknown, agentId?: string) => {
    const response = await fetch(`${swarm.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${swarm.apiKey}`,
        "Content-Type": "application/json",
        "X-Swarm-User-Id": userId,
        ...(agentId ? { "X-Agent-ID": agentId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
    return response.json();
  };

  // A running session under a use-case key, on an agent of its own so no seeded task moves.
  const agent = await api.post<{ id: string }>("/api/agents", {
    name: `e2e-home-worker-${suffix}`,
    isLead: false,
    maxTasks: 1,
  });
  const running = (await call("POST", "/api/tasks", {
    task: `e2e home running ${suffix}`,
    key: groupKey,
    source: "ui",
    requestedByUserId: userId,
    agentId: agent.id,
    routingReason: "human_pinned",
    tags: ["e2e"],
  })) as { id: string };
  await call("GET", "/api/poll", undefined, agent.id);
  await call("PUT", "/api/favorites", { itemType: "key", itemId: groupKey, favorite: true });

  await page.goto("/");
  const needsYou = page.getByRole("region", { name: "Needs you" });
  await expect(needsYou.getByText("All sessions")).toBeVisible();
  const badge = page
    .locator('[data-sidebar="menu-item"]')
    .filter({ has: page.getByRole("link", { name: "Home", exact: true }) })
    .locator('[data-sidebar="menu-badge"]');
  const pill = needsYou.getByRole("img", { name: /needs? you$/ });
  // Other specs share this API, so the count is read from Home, not assumed.
  const pillCount = async () => ((await pill.count()) > 0 ? Number(await pill.innerText()) : 0);

  const approval = await api.post<{ approvalRequest: { id: string } }>("/api/approval-requests", {
    title: `e2e home approval ${suffix}`,
    questions: [{ id: "go", type: "approval", label: "Go?", required: true }],
    approvers: { policy: "any" },
  });
  await expect(needsYou.getByText(`e2e home approval ${suffix}`)).toBeVisible({ timeout: 15_000 });
  const withApproval = await pillCount();
  expect(withApproval).toBeGreaterThanOrEqual(1);
  // The badge on Home in the sidebar shows the same count.
  await expect(badge).toHaveText(String(withApproval), { timeout: 15_000 });

  // The starred group lists in Favorites with what runs in it.
  const favorite = page
    .getByRole("region", { name: "Favorites" })
    .getByRole("link")
    .filter({ hasText: groupName });
  await expect(favorite).toBeVisible();
  await expect(favorite.getByText("1 running")).toBeVisible();

  // Answering the approval takes it off Home and the badge on the next poll (5s).
  await api.post(`/api/approval-requests/${approval.approvalRequest.id}/respond`, {
    responses: { go: { approved: true } },
  });
  const nextPoll = { timeout: 15_000 };
  await expect(needsYou.getByText(`e2e home approval ${suffix}`)).toHaveCount(0, nextPoll);
  await expect.poll(pillCount, nextPoll).toBe(withApproval - 1);
  if (withApproval === 1) await expect(badge).toHaveCount(0, nextPoll);
  else await expect(badge).toHaveText(String(withApproval - 1), nextPoll);

  // Leave the worker's state as found.
  await call("PUT", "/api/favorites", { itemType: "key", itemId: groupKey, favorite: false });
  await call("POST", `/api/tasks/${running.id}/finish`, { status: "completed" }, agent.id);
  await clean.assertClean();
});
