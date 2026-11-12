import { randomUUID } from "node:crypto";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "../fixtures";

/**
 * Sessions v2 sidebar: "Select all N" with a row unchecked, Working, Starred
 * sessions, starred and hidden groups, and the Slack section (paging, and
 * Done sessions that still open from it). Every test starts its own sessions
 * and groups with a run id, so tests that share a worker API never collide.
 * Each test attaches a screenshot of the state it proves.
 */

interface SwarmTarget {
  apiUrl: string;
  apiKey: string;
}

type Api = { post<T>(path: string, body: unknown): Promise<T> };

/** A request as the seeded user, or as an agent with `agentId`. */
async function call<T>(
  swarm: SwarmTarget,
  method: string,
  path: string,
  options: { body?: unknown; userId?: string; agentId?: string } = {},
): Promise<T> {
  const response = await fetch(`${swarm.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${swarm.apiKey}`,
      "Content-Type": "application/json",
      ...(options.userId ? { "X-Swarm-User-Id": options.userId } : {}),
      ...(options.agentId ? { "X-Agent-ID": options.agentId } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/**
 * A session the seeded user started, assigned to worker A so it can finish.
 * Unfinished it is running: it lists under Working. `finished` completes it,
 * so it lists in the Inbox.
 */
async function session(
  api: Api,
  swarm: SwarmTarget,
  input: { userId: string; agentId: string; title: string; key?: string; source?: string },
  finished: boolean,
): Promise<string> {
  const task = await api.post<{ id: string }>("/api/tasks", {
    task: input.title,
    source: input.source ?? "ui",
    ...(input.key ? { key: input.key } : {}),
    agentId: input.agentId,
    routingReason: "human_pinned",
    requestedByUserId: input.userId,
    tags: ["e2e"],
  });
  if (finished) await finish(swarm, input.agentId, task.id);
  return task.id;
}

async function finish(swarm: SwarmTarget, agentId: string, taskId: string): Promise<void> {
  await call(swarm, "POST", `/api/tasks/${taskId}/finish`, {
    agentId,
    body: { status: "completed" },
  });
}

/** Show Slack sessions: the default filter shows the dashboard's own sessions only. */
async function showSlack(page: Page): Promise<void> {
  await page.addInitScript(() =>
    localStorage.setItem("swarm:v1:sessions-v2:shown-sources", "ui,slack"),
  );
}

/** A container row (a section, a source, a group) by the name before its counts. */
function container(tree: Locator, name: string | RegExp, level?: number): Locator {
  const pattern = typeof name === "string" ? new RegExp(`^${escapeRegExp(name)}(,|$)`) : name;
  return tree.getByRole("treeitem", { name: pattern, ...(level ? { level } : {}) });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Open a folded container row with a click on its name. */
async function expand(row: Locator, name: string): Promise<void> {
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) !== "true") {
    await row.getByText(name, { exact: true }).first().click();
  }
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("sessions sidebar", () => {
  test.beforeEach(({ seed, isMobile }) => {
    test.skip(!seed, "remote run without seed");
    test.skip(isMobile, "desktop layout");
  });

  test("running sessions list under Working, and move to the Inbox when they finish", async ({
    page,
    api,
    swarm,
    seed,
    clean,
  }, testInfo) => {
    const run = randomUUID().slice(0, 8);
    const userId = seed!.user.id;
    const agentId = seed!.agents.workerA;
    const title = `e2e working ${run}`;
    const id = await session(api, swarm, { userId, agentId, title }, false);

    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    const working = container(tree, "Working", 1);
    await expect(working).toHaveAttribute("aria-expanded", "true");
    const row = tree.getByRole("treeitem", { name: new RegExp(title), level: 2 });
    await expect(row).toBeVisible();
    // Under Working, not in the Inbox: folding Working hides it.
    await working.getByText("Working", { exact: true }).click();
    await expect(row).toBeHidden();
    await shot(page, testInfo, "working-folded");
    await working.getByText("Working", { exact: true }).click();
    await expect(row).toBeVisible();
    await shot(page, testInfo, "working-open");

    await finish(swarm, agentId, id);
    // Finished: back in the Inbox as unread. Folding Working no longer hides it.
    await expect(row).toHaveAccessibleName(/^Unread\. /, { timeout: 20_000 });
    if (await working.isVisible()) {
      await working.getByText("Working", { exact: true }).click();
      await expect(row).toBeVisible();
    }
    await clean.assertClean();
  });

  test("after Select all N, unchecking one row keeps every other session selected", async ({
    page,
    api,
    swarm,
    seed,
    clean,
  }, testInfo) => {
    const run = randomUUID().slice(0, 8);
    const userId = seed!.user.id;
    const agentId = seed!.agents.workerA;
    // More than the 10 rows the Inbox shows, so "Select all N" is offered.
    for (let i = 0; i < 12; i++) {
      await session(api, swarm, { userId, agentId, title: `e2e select ${run} ${i}` }, true);
    }
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    const inbox = container(tree, "Inbox", 1);
    await expect(inbox).toHaveAttribute("aria-expanded", "true");
    await expect(tree.getByRole("treeitem", { name: new RegExp(`select ${run}`) })).toHaveCount(10);

    await inbox.hover();
    await inbox.locator('button[role="checkbox"]').click();
    const bar = page.locator("[data-bulk-bar]");
    const selectAll = bar.getByRole("button", { name: /^Select all \d+ in Inbox$/ });
    const total = Number((await selectAll.getAttribute("aria-label"))!.match(/\d+/)![0]);
    expect(total).toBeGreaterThan(10);
    await selectAll.click();
    await expect(bar).toContainText(`All ${total} in Inbox`);

    const first = tree.getByRole("treeitem", { name: new RegExp(`select ${run}`) }).first();
    await first.locator('button[role="checkbox"]').click();
    // Still the whole list, less one: not the 9 loaded rows.
    await expect(bar).toContainText(`${total - 1} of ${total} in Inbox`);
    await shot(page, testInfo, "select-all-minus-one");
    await bar.getByRole("button", { name: "Clear selection" }).click();
    await clean.assertClean();
  });

  test("a starred session lists under Starred", async ({
    page,
    api,
    swarm,
    seed,
    clean,
  }, testInfo) => {
    const run = randomUUID().slice(0, 8);
    const userId = seed!.user.id;
    const title = `e2e star ${run}`;
    const id = await session(api, swarm, { userId, agentId: seed!.agents.workerA, title }, true);

    await page.goto(`/sessions/${id}`);
    const tree = page.getByRole("tree", { name: "Sessions" });
    await page
      .getByRole("tabpanel", { name: title })
      .getByRole("button", { name: "Star this session" })
      .click();
    const starred = page.getByRole("group", { name: /^Starred, / });
    await expect(starred.getByRole("treeitem", { name: new RegExp(title) })).toBeVisible();
    await shot(page, testInfo, "starred-session");

    // The row menu unstars it.
    await starred.getByRole("treeitem", { name: new RegExp(title) }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unstar session" }).click();
    await expect(starred).toBeHidden();
    await expect(tree.getByRole("treeitem", { name: new RegExp(title) }).first()).toBeVisible();
    await clean.assertClean();
  });

  test("a starred group sorts first, and a hidden group leaves until shown", async ({
    page,
    api,
    swarm,
    seed,
    clean,
  }, testInfo) => {
    const run = randomUUID().slice(0, 8);
    const userId = seed!.user.id;
    const agentId = seed!.agents.workerA;
    const older = `e2e-fav-${run}-a`;
    const newer = `e2e-fav-${run}-b`;
    await session(
      api,
      swarm,
      { userId, agentId, title: `e2e ${older}`, key: `shared/${older}/` },
      true,
    );
    await session(
      api,
      swarm,
      { userId, agentId, title: `e2e ${newer}`, key: `shared/${newer}/` },
      true,
    );

    await page.goto("/sessions");
    const mine = page.getByRole("group", { name: /^My groups/ });
    const names = async () =>
      (await mine.getByRole("treeitem", { level: 1 }).allTextContents()).filter((text) =>
        text.includes(run),
      );
    await expect.poll(async () => (await names())[0]).toContain(newer);

    const olderRow = container(mine, older, 1);
    await olderRow.hover();
    await olderRow.getByRole("button", { name: "Star this use case" }).click();
    await expect.poll(async () => (await names())[0]).toContain(older);
    await shot(page, testInfo, "starred-group-first");

    const newerRow = container(mine, newer, 1);
    await newerRow.hover();
    await newerRow.getByRole("button", { name: "Hide this group" }).click();
    await expect(newerRow).toBeHidden();
    const reveal = page.getByRole("treeitem", { name: /^Show \d+ hidden$/ });
    await expect(reveal).toBeVisible();
    await shot(page, testInfo, "hidden-group");

    await reveal.click();
    await expect(newerRow).toBeVisible();
    await shot(page, testInfo, "hidden-group-shown");
    // Unhide and unstar: the worker's other tests see the groups as they were.
    await newerRow.hover();
    await newerRow.getByRole("button", { name: "Show this group again" }).click();
    await olderRow.hover();
    await olderRow.getByRole("button", { name: "Unstar" }).click();
    await expect.poll(async () => (await names())[0]).toContain(newer);
    await clean.assertClean();
  });

  test("Slack shows its 10 newest groups, then more; a Done DM session still opens", async ({
    page,
    api,
    swarm,
    seed,
    clean,
  }, testInfo) => {
    const run = randomUUID().slice(0, 8);
    const userId = seed!.user.id;
    const agentId = seed!.agents.workerA;
    // 11 channels, then one DM whose only session is Done.
    for (let i = 0; i < 11; i++) {
      await session(
        api,
        swarm,
        {
          userId,
          agentId,
          title: `e2e slack ${run} ${i}`,
          key: `shared/slack/c0e2e${run}${i}/`,
          source: "slack",
        },
        true,
      );
    }
    const dm = `shared/slack/d0e2e${run}/`;
    const dmTitle = `e2e slack dm ${run}`;
    const dmId = await session(
      api,
      swarm,
      { userId, agentId, title: dmTitle, key: dm, source: "slack" },
      true,
    );
    await call(swarm, "PATCH", "/api/inbox-state", {
      userId,
      body: { userId, itemType: "to_read", itemId: dmId, status: "done" },
    });

    await showSlack(page);
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    await expand(container(tree, /^Slack, /, 1), "Slack");
    const groups = tree.getByRole("treeitem", { level: 2 });
    // The DM is the newest: first of the 10 shown, then "Show N more".
    const more = tree.getByRole("treeitem", { name: /^Show \d+ more$/ }).first();
    await expect(more).toBeVisible();
    await shot(page, testInfo, "slack-first-10");

    // The DM's Done session lists under it, and a click opens it.
    const dmRow = groups.filter({ hasText: /^DM/ }).first();
    await expect(dmRow).toBeVisible();
    await dmRow.getByText(/^DM/).first().click();
    const dmSession = tree.getByRole("treeitem", { name: new RegExp(dmTitle), level: 3 });
    await expect(dmSession).toBeVisible();
    await shot(page, testInfo, "slack-done-dm-session");
    await dmSession.click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${dmId}(\\?|$)`));
    await clean.assertClean();
  });
});
