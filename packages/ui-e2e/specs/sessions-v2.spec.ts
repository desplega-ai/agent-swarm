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
 * - One API serves the whole worker, and retries and `--repeat-each` reuse it. A test that
 *   changes a session's state starts its own session first.
 */

const PHONE_PROJECT = "mobile-iphone";

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

/** A container row of the tree (Inbox, Done, a group), by its name before the counts. */
function container(scope: Locator, name: string): Locator {
  return scope.getByRole("treeitem", { name: new RegExp(`^${name}(,|$)`) });
}

/**
 * Open a container row. A click on an open container would fold it. The click goes to the
 * name: a group row shows its "Group actions" and "New session" buttons on hover, and the
 * middle of the row can be one of them.
 */
async function expand(scope: Locator, name: string): Promise<void> {
  const row = container(scope, name);
  await expect(row).toBeVisible();
  if ((await row.getAttribute("aria-expanded")) !== "true") {
    await row.getByText(name, { exact: true }).click();
  }
  await expect(row).toHaveAttribute("aria-expanded", "true");
}

/**
 * The accessible names of the rows under one container. The tree is flat: a row belongs to
 * the nearest level 1 container above it.
 */
async function rowsIn(tree: Locator, name: string): Promise<string[]> {
  const items = await tree.getByRole("treeitem").evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.getAttribute("aria-label") ?? "",
      level: Number(node.getAttribute("aria-level")),
    })),
  );
  const rows: string[] = [];
  let inside = false;
  for (const item of items) {
    if (item.level === 1) inside = item.name.split(",")[0] === name;
    else if (inside) rows.push(item.name);
  }
  return rows;
}

test.describe("desktop", () => {
  test.beforeEach(({ seed }, testInfo) => {
    test.skip(!seed, "remote run without seed");
    test.skip(testInfo.project.name === PHONE_PROJECT, "desktop layout, see the phone test");
  });

  test("the tree shows the seeded group and its shared session", async ({ page, seed, clean }) => {
    const { teammate } = seed!.sessionChain;
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    await expand(page.getByRole("group", { name: /^My groups/ }), "e2e-sessions");
    await expect
      .poll(() => rowsIn(tree, "e2e-sessions"))
      .toContainEqual(
        expect.stringMatching(
          new RegExp(`e2e grouped session\\. .*Shared with ${teammate.name} \\(can view\\)`),
        ),
      );
    await clean.assertClean();
  });

  test("opening a session marks it read", async ({ page, api, swarm, seed, clean }) => {
    const session = await startSession(api, seed!.user.id, "read");
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    const row = tree.getByRole("treeitem", { name: session.title });
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

    const done = page.getByRole("group", { name: "Triage" }).getByRole("button", { name: "Done" });
    await expect(done).toHaveAttribute("aria-pressed", "false");
    await done.click();
    await expect(done).toHaveAttribute("aria-pressed", "true");

    const tree = page.getByRole("tree", { name: "Sessions" });
    await expand(tree, "Done");
    const holds = (rows: string[]) => rows.some((row) => row.includes(session.title));
    await expect
      .poll(async () => ({
        inbox: holds(await rowsIn(tree, "Inbox")),
        done: holds(await rowsIn(tree, "Done")),
      }))
      .toEqual({ inbox: false, done: true });
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
    const { groupKey } = seed!.sessionChain;
    const session = await startSession(api, seed!.user.id, "move");
    await page.goto(`/sessions/${session.id}`);
    await expect(page.getByRole("heading", { level: 2, name: session.title })).toBeVisible();

    await page
      .getByRole("group", { name: "Triage" })
      .getByRole("button", { name: "Move to group" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Move to group" });
    await dialog.getByPlaceholder("Pick a group, or type a new name").fill("e2e-sessions");
    await dialog.getByRole("option", { name: "e2e-sessions", exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => (await sessionFor(swarm, seed!.user.id, session.id)).root.key)
      .toBe(groupKey);
    // The pane header crumb names the new group.
    await expect(
      page
        .getByRole("tabpanel", { name: session.title })
        .getByRole("button", { name: "e2e-sessions", exact: true }),
    ).toBeVisible();
    const tree = page.getByRole("tree", { name: "Sessions" });
    await expand(tree, "e2e-sessions");
    await expect
      .poll(() => rowsIn(tree, "e2e-sessions"))
      .toContainEqual(expect.stringContaining(session.title));
    await clean.assertClean();
  });

  test("the Legacy toggle switches the view and back", async ({ page, clean }) => {
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    const legacy = page.getByRole("button", { name: "Legacy sessions" });
    const v2 = page.getByRole("button", { name: "New sessions view" });
    await expect(tree).toBeVisible();

    await legacy.click();
    await expect(v2).toBeVisible();
    await expect(tree).toBeHidden();
    // The pick is a per-browser preference, so a reload keeps the Legacy view.
    await page.reload();
    await expect(v2).toBeVisible();
    await expect(tree).toBeHidden();

    await v2.click();
    await expect(tree).toBeVisible();
    await expect(legacy).toBeVisible();
    await clean.assertClean();
  });
});

test.describe("phone", () => {
  test.beforeEach(({ seed }, testInfo) => {
    test.skip(!seed, "remote run without seed");
    test.skip(testInfo.project.name !== PHONE_PROJECT, "phone layout, runs on the phone project");
  });

  test("the list opens the session detail and back returns", async ({ page, seed, clean }) => {
    const { root } = seed!.sessionChain;
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    const detail = page.getByRole("region", { name: "Session" });
    // The Inbox row of the seeded root. Rows in a flat list name their group.
    const row = tree.getByRole("treeitem", { name: "e2e grouped session. In e2e-sessions" });

    await row.tap();
    await expect(page).toHaveURL(new RegExp(`/sessions/${root}(\\?|$)`));
    await expect(
      detail.getByRole("button", { name: "e2e grouped session. Rename session" }),
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
