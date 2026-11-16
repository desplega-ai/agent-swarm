import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

/**
 * `ObjectEmbed` in an app. The object routes act on agent-fs, which this suite
 * does not run, so `/api/objects/:id/*` is stubbed in the browser with the
 * route contract (scripts/e2e/scenarios/objects-http.ts covers the server).
 * The stub recalculates the one formula (`B2 = A2*2`) the way the server would.
 */

const sheetId = "5f0c2a52-58c4-4c11-9e43-6f1f3c0f1a01";
const boardId = "5f0c2a52-58c4-4c11-9e43-6f1f3c0f1a02";

type Cell = { v?: number | string | boolean | null; f?: string };

const object = (id: string, kind: string, version: number) => ({
  id,
  kind,
  orgId: "org",
  driveId: "drive",
  path: `/objects/e2e.${kind}`,
  title: `e2e ${kind}`,
  fileVersion: version,
  ownerAgentId: null,
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  link: null,
});

/** An in-memory sheet behind GET and POST sheet-ops; survives page reloads. */
async function stubSheet(page: Page) {
  let version = 1;
  const cells: Record<string, Cell> = {
    A1: { v: "qty" },
    B1: { v: "double" },
    A2: { v: 2 },
    B2: { v: 4, f: "=A2*2" },
  };
  const ops: unknown[] = [];
  await page.route(`**/api/objects/${sheetId}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/sheet-ops")) {
      const op = request.postDataJSON() as { range: string; values: Cell["v"][][] };
      ops.push(op);
      const ref = op.range.split("!").pop() ?? "";
      cells[ref] = { v: op.values[0]?.[0] ?? null };
      cells.B2 = { v: Number(cells.A2?.v ?? 0) * 2, f: "=A2*2" };
      version += 1;
      await route.fulfill({
        json: { op: "setRange", range: op.range, version, changed: 1, recalculated: 1 },
      });
      return;
    }
    if (url.searchParams.get("knownVersion") === String(version)) {
      await route.fulfill({
        json: { object: object(sheetId, "sheet", version), version, unchanged: true },
      });
      return;
    }
    await route.fulfill({
      json: {
        object: object(sheetId, "sheet", version),
        version,
        unchanged: false,
        content: {
          format: "swarm-sheet/1",
          swarm: { id: sheetId, kind: "sheet" },
          tabs: [{ name: "Sheet1", cells }],
        },
      },
    });
  });
  return ops;
}

async function createApp(
  api: { post: <T>(path: string, body: unknown) => Promise<T> },
  name: string,
  objectId: string,
) {
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name,
    definition: {
      models: {},
      queries: {},
      pages: {
        main: {
          root: "embed",
          elements: { embed: { type: "ObjectEmbed", props: { objectId, height: 420 } } },
        },
      },
      defaultPage: "main",
    },
  });
  return app.id;
}

test("ObjectEmbed sheet: an edited cell saves, recalculates and survives a reload", {
  tag: "@objects",
}, async ({ page, api, seed, clean }) => {
  test.skip(!seed, "remote run without seed");
  const ops = await stubSheet(page);
  const appId = await createApp(api, "e2e-object-embed-sheet", sheetId);
  try {
    await page.goto(`/apps/${appId}`);
    const grid = page.locator('[data-object-kind="sheet"]');
    const a2 = grid.locator('.ag-row[row-id="2"] [col-id="A"]');
    const b2 = grid.locator('.ag-row[row-id="2"] [col-id="B"]');
    await expect(b2).toHaveText("4");

    await a2.dblclick();
    const editor = grid.locator(".ag-cell-editor input");
    await expect(editor).toHaveValue("2");
    await editor.fill("21");
    await editor.press("Enter");
    await expect(b2).toHaveText("42");
    expect(ops).toEqual([{ op: "setRange", range: "'Sheet1'!A2", values: [[21]] }]);

    // A formula cell edits as its formula.
    await b2.dblclick();
    await expect(editor).toHaveValue("=A2*2");
    await editor.press("Escape");

    await page.reload();
    await expect(a2).toHaveText("21");
    await expect(b2).toHaveText("42");
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${appId}`);
  }
});

type BoardSave = { content: { elements: unknown[]; swarm: unknown }; ifMatch: number };

/** A board at version 1 behind GET; each PUT takes the next canned answer. */
async function stubBoard(page: Page, answers: Array<{ status: number; version: number }>) {
  const saves: BoardSave[] = [];
  await page.route(`**/api/objects/${boardId}**`, async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      saves.push(request.postDataJSON());
      const { status, version } = answers.shift() ?? { status: 200, version: 99 };
      await route.fulfill(
        status === 409
          ? { status, json: { error: "the board changed on agent-fs", version } }
          : { json: { object: object(boardId, "board", version), version } },
      );
      return;
    }
    await route.fulfill({
      json: {
        object: object(boardId, "board", 1),
        version: 1,
        unchanged: new URL(request.url()).searchParams.has("knownVersion"),
        content: {
          type: "excalidraw",
          version: 2,
          elements: [],
          appState: { viewBackgroundColor: "#ffffff" },
          files: {},
          swarm: { id: boardId, kind: "board" },
        },
      },
    });
  });
  return saves;
}

async function drawRectangle(page: Page) {
  const canvas = page.locator('[data-object-kind="board"] canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("board canvas has no box");
  await canvas.click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("r");
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
}

test("ObjectEmbed board: a drawn rectangle autosaves the scene with ifMatch", {
  tag: "@objects",
}, async ({ page, api, seed }) => {
  test.skip(!seed, "remote run without seed");
  const saves = await stubBoard(page, [{ status: 200, version: 2 }]);
  const appId = await createApp(api, "e2e-object-embed-board", boardId);
  try {
    await page.goto(`/apps/${appId}`);
    await drawRectangle(page);
    await expect.poll(() => saves.length, { timeout: 10_000 }).toBe(1);
    expect(saves[0]?.ifMatch).toBe(1);
    expect(saves[0]?.content.elements).toHaveLength(1);
    expect(saves[0]?.content.swarm).toEqual({ id: boardId, kind: "board" });
  } finally {
    await api.delete(`/api/apps/${appId}`);
  }
});

test("ObjectEmbed board: a save 409 offers Keep mine, which saves over the newer version", {
  tag: "@objects",
}, async ({ page, api, seed }) => {
  test.skip(!seed, "remote run without seed");
  const saves = await stubBoard(page, [
    { status: 409, version: 2 },
    { status: 200, version: 3 },
  ]);
  const appId = await createApp(api, "e2e-object-embed-conflict", boardId);
  try {
    await page.goto(`/apps/${appId}`);
    await drawRectangle(page);
    const banner = page.getByRole("alert").filter({ hasText: "Someone else changed this board." });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await banner.getByRole("button", { name: "Keep mine" }).click();
    await expect(banner).toBeHidden();
    expect(saves.map((save) => save.ifMatch)).toEqual([1, 2]);
    expect(saves[1]?.content.elements).toHaveLength(1);
  } finally {
    await api.delete(`/api/apps/${appId}`);
  }
});
