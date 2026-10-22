import { randomUUID } from "node:crypto";
import type { Locator } from "@playwright/test";
import { expect, test } from "../fixtures";

/**
 * Sessions v2 (`apps/ui/src/components/sessions-v2/`): the sidebar tree, triage, the move
 * dialog, the Legacy toggle, and the phone screens.
 *
 * - The test API runs with `SWARM_DEV_MODE=true` (`boot/sut.ts`). It is older than
 *   `SESSIONS_V2_MIN_VERSION`, and dev mode opens the version gate.
 * - The `storageState` fixture turns the first-run guide off, so its dialog does not block clicks.
 * - One API serves each Playwright worker. Tests that share a worker, and `--repeat-each`,
 *   reuse it. So a test that changes a session's state starts its own session first, and the
 *   seeded chain stays read-only.
 * - The sidebar tree is flat: `level` gives the depth. A row shows only while its container is
 *   open, so "hidden while folded, visible once open" proves which container holds it.
 */

interface SwarmTarget {
  apiUrl: string;
  apiKey: string;
}

interface StartedSession {
  id: string;
  title: string;
}

/** A new session that `userId` starts: unread, in No group, and the newest row in the Inbox. */
async function startSession(
  api: { post<T>(path: string, body: unknown): Promise<T> },
  userId: string,
  name: string,
): Promise<StartedSession> {
  const title = `e2e v2 ${name} ${randomUUID().slice(0, 8)}`;
  const task = await api.post<{ id: string }>("/api/tasks", {
    task: title,
    source: "ui",
    requestedByUserId: userId,
    tags: ["e2e"],
  });
  return { id: task.id, title };
}

/** The session as `userId` sees it: the read state and the root key that the server stores. */
async function sessionFor(swarm: SwarmTarget, userId: string, rootId: string) {
  const response = await fetch(`${swarm.apiUrl}/api/sessions/${rootId}`, {
    headers: { Authorization: `Bearer ${swarm.apiKey}`, "x-swarm-user-id": userId },
  });
  if (!response.ok) throw new Error(`GET /api/sessions/${rootId} failed: ${response.status}`);
  return (await response.json()) as { root: { key: string }; readState?: string };
}

/** A session row of the tree: level 2, under a section or a top-level group. */
function sessionRow(tree: Locator, name: string): Locator {
  return tree.getByRole("treeitem", { name, level: 2 });
}

/**
 * Open a container row (Inbox, Done, a group), named by its label before the counts. A click
 * on an open container would fold it. The click goes to the visible name, which has no role
 * of its own: a group row shows its "Group actions" and "New session" buttons on hover, and
 * the middle of the row can be one of them.
 */
async function expand(scope: Locator, name: string): Promise<void> {
  const row = scope.getByRole("treeitem", { name: new RegExp(`^${name}(,|$)`), level: 1 });
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) !== "true") {
    await row.getByText(name, { exact: true }).click();
  }
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

test.describe("desktop", () => {
  test.beforeEach(({ seed, isMobile }) => {
    test.skip(!seed, "remote run without seed");
    test.skip(isMobile, "desktop layout, see the phone test");
  });

  test("the tree shows the seeded group and its shared session", async ({ page, seed, clean }) => {
    const { title, groupName, teammate } = seed!.sessionChain;
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    // Inside its group a row does not name the group ("In <group>"), unlike the Inbox row.
    const inGroup = sessionRow(
      tree,
      `${title}. With you, ${teammate.name}. Shared with ${teammate.name} (can view)`,
    );
    await expect(inGroup).toBeHidden();

    await expand(page.getByRole("group", { name: /^My groups/ }), groupName);
    await expect(inGroup).toBeVisible();
    await clean.assertClean();
  });

  test("opening a session marks it read", async ({ page, api, swarm, seed, clean }) => {
    const session = await startSession(api, seed!.user.id, "read");
    await page.goto("/sessions");
    const row = sessionRow(page.getByRole("tree", { name: "Sessions" }), session.title);
    await expect(row).toHaveAccessibleName(/^Unread\. /);

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}(\\?|$)`));
    await expect(page.getByRole("heading", { level: 2, name: session.title })).toBeVisible();
    await expect(row).not.toHaveAccessibleName(/^Unread\. /);
    await expect
      .poll(async () => (await sessionFor(swarm, seed!.user.id, session.id)).readState)
      .toBe("read");
    await clean.assertClean();
  });

  test("Done moves the session to Done", async ({ page, api, swarm, seed, clean }) => {
    const session = await startSession(api, seed!.user.id, "done");
    await page.goto(`/sessions/${session.id}`);
    // Opening the session writes the read mark first. Let it land, so the Done write is the last one.
    await expect
      .poll(async () => (await sessionFor(swarm, seed!.user.id, session.id)).readState)
      .toBe("read");
    const tree = page.getByRole("tree", { name: "Sessions" });
    // The Inbox is open. Done and No group start folded.
    const row = sessionRow(tree, session.title);
    await expect(row).toBeVisible();

    const done = page.getByRole("group", { name: "Triage" }).getByRole("button", { name: "Done" });
    await expect(done).toHaveAttribute("aria-pressed", "false");
    await done.click();
    await expect(done).toHaveAttribute("aria-pressed", "true");
    // Out of the Inbox, and in Done: the row comes back when Done opens.
    await expect(row).toBeHidden();
    await expand(tree, "Done");
    await expect(row).toBeVisible();
    await expect
      .poll(async () => (await sessionFor(swarm, seed!.user.id, session.id)).readState)
      .toBe("done");
    await clean.assertClean();
  });

  test("the move dialog moves a session into a group", async ({
    page,
    api,
    swarm,
    seed,
    clean,
  }) => {
    const { groupKey, groupName } = seed!.sessionChain;
    const session = await startSession(api, seed!.user.id, "move");
    await page.goto(`/sessions/${session.id}`);
    await expect(page.getByRole("heading", { level: 2, name: session.title })).toBeVisible();

    await page
      .getByRole("group", { name: "Triage" })
      .getByRole("button", { name: "Move to group" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Move to group" });
    await dialog.getByRole("combobox").fill(groupName);
    await dialog.getByRole("option", { name: groupName, exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => (await sessionFor(swarm, seed!.user.id, session.id)).root.key)
      .toBe(groupKey);
    // The pane header crumb names the new group.
    await expect(
      page
        .getByRole("tabpanel", { name: session.title })
        .getByRole("button", { name: groupName, exact: true }),
    ).toBeVisible();
    // The Inbox row names its group, and the open group holds a second row.
    const tree = page.getByRole("tree", { name: "Sessions" });
    await expect(sessionRow(tree, `${session.title}. In ${groupName}.`)).toBeVisible();
    await expand(tree, groupName);
    await expect(sessionRow(tree, session.title)).toHaveCount(2);
    await clean.assertClean();
  });

  test("the Legacy toggle switches the view and back", async ({ page, seed, clean }) => {
    const { title, root } = seed!.sessionChain;
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    const legacy = page.getByRole("button", { name: "Legacy sessions" });
    const v2 = page.getByRole("button", { name: "New sessions view" });
    // Controls only the Legacy view has: its list search and a link per session.
    const legacySearch = page.getByRole("textbox", {
      name: "Search sessions by title or initial task text",
    });
    const legacyRow = page.getByRole("link", { name: title });
    await expect(tree).toBeVisible();
    await expect(legacySearch).toBeHidden();

    await legacy.click();
    await expect(v2).toBeVisible();
    await expect(legacySearch).toBeVisible();
    await expect(legacyRow).toHaveAttribute("href", `/sessions/${root}`);
    await expect(tree).toBeHidden();
    // The pick is a per-browser preference, so a reload keeps the Legacy view.
    await page.reload();
    await expect(legacySearch).toBeVisible();
    await expect(tree).toBeHidden();

    await v2.click();
    await expect(tree).toBeVisible();
    await expect(legacy).toBeVisible();
    await expect(legacySearch).toBeHidden();
    await clean.assertClean();
  });
});

test.describe("phone", () => {
  test.beforeEach(({ seed, isMobile }) => {
    test.skip(!seed, "remote run without seed");
    test.skip(!isMobile, "phone layout, runs on the mobile-iphone project");
  });

  test("the list opens the session detail and back returns", async ({ page, api, seed, clean }) => {
    const session = await startSession(api, seed!.user.id, "phone");
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    const detail = page.getByRole("region", { name: "Session" });
    const row = sessionRow(tree, session.title);

    await row.tap();
    await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}(\\?|$)`));
    await expect(
      detail.getByRole("button", { name: `${session.title}. Rename session` }),
    ).toBeVisible();
    await expect(tree).toBeHidden();

    await detail.getByRole("button", { name: "Back to sessions" }).tap();
    await expect(page).toHaveURL(/\/sessions(\?|$)/);
    await expect(tree).toBeVisible();
    await expect(detail).toBeHidden();

    // The detail is a history entry, so the browser back button returns too.
    await row.tap();
    await expect(detail).toBeVisible();
    await page.goBack();
    await expect(tree).toBeVisible();
    await expect(detail).toBeHidden();
    await clean.assertClean();
  });
});
