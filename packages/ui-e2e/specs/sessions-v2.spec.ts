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

  test("cites selected outcome text in a follow-up", async ({ page, api, swarm, seed, clean }) => {
    const { id: agentId } = await api.post<{ id: string }>("/api/agents", {
      name: `citation-worker-${randomUUID().slice(0, 8)}`,
      isLead: false,
    });
    const session = await api.post<{ id: string }>("/api/tasks", {
      task: "Summarize the cleanup work",
      source: "ui",
      requestedByUserId: seed!.user.id,
      agentId,
      routingReason: "human_pinned",
    });
    const output = "The **cleanup goal is paused** for now.\n\nA second passage.";
    const headers = {
      Authorization: `Bearer ${swarm.apiKey}`,
      "Content-Type": "application/json",
      "X-Agent-ID": agentId,
    };
    const poll = await fetch(`${swarm.apiUrl}/api/poll`, { headers });
    expect(poll.ok).toBe(true);
    const response = await fetch(`${swarm.apiUrl}/api/tasks/${session.id}/finish`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "completed", output }),
    });
    expect(response.ok).toBe(true);
    expect((await response.json()).task.output).toBe(output);
    await page.goto(`/sessions/${session.id}`);

    const select = (passage: Locator) =>
      passage.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });

    await select(page.getByText("cleanup goal is paused", { exact: true }));
    const cite = page.getByRole("button", { name: "Cite", exact: true });
    await cite.click();
    const excerpt = page.getByRole("group", { name: "Cited excerpts" });
    await expect(excerpt).toContainText("cleanup goal is paused");
    const composer = page.getByRole("textbox", { name: "Follow up…" });
    await expect(composer).toBeFocused();
    await composer.fill("What needs to happen next?");

    const secondPassage = page.getByText("A second passage.", { exact: true });
    await secondPassage.click();
    await select(secondPassage);
    await expect(cite).toBeVisible();
    await page.keyboard.press("c");
    await expect(excerpt).toContainText("A second passage.");
    await page.reload();
    await expect(excerpt).toContainText("cleanup goal is paused");
    await expect(composer).toContainText("What needs to happen next?");
    await excerpt.getByRole("button", { name: "Remove citation 2" }).click();
    await expect(excerpt).not.toContainText("A second passage.");

    const sent = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks",
    );
    await page.getByRole("button", { name: "Follow up", exact: true }).click();
    expect((await sent).postDataJSON().task).toBe(
      "> cleanup goal is paused\n\nWhat needs to happen next?",
    );
    await expect(excerpt).toBeHidden();
    await clean.assertClean();
  });

  test("a lead turn that ends while the person types keeps the composer focused", async ({
    page,
    api,
    seed,
    clean,
  }) => {
    // A lead task that has not ended: the composer is the steer box.
    const session = await api.post<{ id: string }>("/api/tasks", {
      task: "Draft the release notes",
      source: "ui",
      requestedByUserId: seed!.user.id,
      agentId: seed!.agents.lead,
      routingReason: "human_pinned",
    });
    // The test API turns steering off; the dashboard reads the flag from stats.
    await page.route("**/api/stats", async (route) => {
      // The steer box polls stats, so a reused keep-alive socket the API already closed
      // fails as ECONNRESET ("socket hang up"). maxRetries retries exactly that error.
      const response = await route.fetch({ maxRetries: 2 });
      return route.fulfill({
        response,
        json: { ...(await response.json()), steeringEnabled: true },
      });
    });
    await page.goto(`/sessions/${session.id}`);

    const box = page.locator("form").getByRole("textbox");
    await expect(page.getByRole("button", { name: "Steer", exact: true })).toBeVisible();
    await box.click();
    await page.keyboard.type("half a thought");
    const steerEditor = await box.elementHandle();

    // The turn ends: the next poll swaps the steer box for the follow-up dock, a new editor.
    await api.post(`/api/tasks/${session.id}/cancel`, {});
    await expect
      .poll(() => steerEditor!.evaluate((element) => element.isConnected), { timeout: 15_000 })
      .toBe(false);
    await expect(box).toBeFocused();
    await page.keyboard.type(", and more");
    await expect(box).toContainText("half a thought, and more");
    await clean.assertClean();
  });

  test("a follow-up with a file shows in the session while the file uploads", async ({
    page,
    api,
    seed,
    clean,
  }) => {
    const session = await startSession(api, seed!.user.id, "upload");
    await api.post(`/api/tasks/${session.id}/cancel`, {});

    // Hold the upload: the turn must show before it finishes.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/fs/tasks/*/files?*", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await held;
      return route.fulfill({
        status: 201,
        json: { id: randomUUID(), name: "notes.txt", intent: "user-upload" },
      });
    });
    // The test API has no file store: the draft's file list comes back empty.
    await page.route("**/api/fs/tasks/*/files", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { attachments: [] } })
        : route.fallback(),
    );
    await page.goto(`/sessions/${session.id}`);

    const box = page.locator("form").getByRole("textbox");
    await box.click();
    await page.keyboard.type("see the attached notes");
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("notes"),
    });
    await page.getByRole("button", { name: "Follow up", exact: true }).click();

    const turn = page.getByRole("region", { name: "Your message" }).filter({
      hasText: "see the attached notes",
    });
    await expect(turn).toContainText("Uploading files…");
    await expect(box).not.toContainText("see the attached notes");

    release();
    await expect(turn).not.toContainText("Uploading files…", { timeout: 15_000 });
    await clean.assertClean();
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
    // A running session hides the dot (the spinner says it); a settled one shows it.
    await api.post(`/api/tasks/${session.id}/cancel`, {});
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
    // Filed into a group, the session leaves the Inbox and shows under the group only.
    const tree = page.getByRole("tree", { name: "Sessions" });
    await expect(sessionRow(tree, `${session.title}. In ${groupName}.`)).toBeHidden();
    await expand(tree, groupName);
    await expect(sessionRow(tree, session.title)).toHaveCount(1);
    await clean.assertClean();
  });

  test("the pane crumb of a session in a shared Slack thread opens its channel", async ({
    page,
    api,
    seed,
    clean,
  }) => {
    // Two owned roots in one Slack thread: the server nests them as a thread group.
    const run = randomUUID().slice(0, 8);
    const prefix = `e2e v2 thread ${run}`;
    const key = `shared/slack/c0e2e${run}/thread:1729000000.${run}/`;
    const roots: { id: string }[] = [];
    for (const name of ["a", "b"]) {
      roots.push(
        await api.post<{ id: string }>("/api/tasks", {
          task: `${prefix} ${name}`,
          source: "slack",
          key,
          requestedByUserId: seed!.user.id,
          tags: ["e2e"],
        }),
      );
    }
    await page.addInitScript(() =>
      localStorage.setItem("swarm:v1:sessions-v2:shown-sources", "ui,slack"),
    );
    await page.goto(`/sessions/${roots[0]!.id}`);
    const tree = page.getByRole("tree", { name: "Sessions" });
    // The thread's sessions list in their channel, and the folded Slack section hides them.
    // Unread session rows start with "Unread.", so this name is not anchored.
    const rows = tree.getByRole("treeitem", { name: new RegExp(prefix), level: 3 });
    await expect(rows).toHaveCount(0);

    await page
      .getByRole("tabpanel", { name: `${prefix} a` })
      .getByRole("button", { name: new RegExp(`^Slack › ${prefix}`) })
      .click();
    // The crumb opens the channel: both thread sessions are rows of its one list, no thread row.
    await expect(rows).toHaveCount(2);
    await expect(tree.getByRole("treeitem", { name: new RegExp(prefix), level: 4 })).toHaveCount(0);
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

  test("Tab enters the phone session tree and Enter opens a session", async ({
    page,
    api,
    seed,
    clean,
  }) => {
    const session = await startSession(api, seed!.user.id, "phone keyboard");
    await page.goto("/sessions");
    const tree = page.getByRole("tree", { name: "Sessions" });
    const rows = tree.getByRole("treeitem");
    const container = rows.first();
    const row = sessionRow(tree, session.title);
    await expect(row).toBeVisible();

    await page.getByRole("button", { name: "More", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(tree).toBeFocused();
    await expect(tree).toHaveAttribute(
      "aria-activedescendant",
      await container.evaluate((item) => item.id),
    );
    await expect(container).toHaveAttribute("data-cursor", "true");

    await expect(container).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(container).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("ArrowRight");
    await expect(container).toHaveAttribute("aria-expanded", "true");

    const rowId = await row.evaluate((item) => item.id);
    const rowIds = await rows.evaluateAll((items) => items.map((item) => item.id));
    const rowIndex = rowIds.indexOf(rowId);
    for (let i = 0; i < rowIndex; i++) await page.keyboard.press("ArrowDown");
    await expect(tree).toHaveAttribute("aria-activedescendant", rowId);
    await expect(row.locator('[data-cursor="true"]')).toBeVisible();
    await expect(container).not.toHaveAttribute("data-cursor", "true");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/sessions/${session.id}(\\?|$)`));
    await clean.assertClean();
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

  test("a tap on the filter button opens the filter sheet, not search", async ({ page, clean }) => {
    await page.goto("/sessions");
    await page.getByRole("button", { name: /^Filter sessions/ }).tap();
    const sheet = page.getByRole("dialog", { name: "Filter sessions" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("checkbox", { name: /^Dashboard/ })).toBeChecked();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await clean.assertClean();
  });

  test("the search icon opens the field in the title row", async ({ page, clean }) => {
    await page.goto("/sessions");
    const title = page.getByRole("heading", { name: "Sessions", level: 1 });
    await expect(title).toBeVisible();
    await page.getByRole("button", { name: "Search sessions" }).tap();
    const field = page.getByRole("textbox", { name: "Search sessions" });
    await expect(field).toBeFocused();
    await expect(title).toBeHidden();
    await page.getByRole("button", { name: "Cancel" }).tap();
    await expect(title).toBeVisible();
    await expect(field).toBeHidden();
    await clean.assertClean();
  });
});
