import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getDbClient, initDb, upsertSwarmConfig } from "../be/db";
import { type BoardElement, measureText } from "../be/primitives/boards/elements";
import {
  addBoardElements,
  createBoard,
  getBoard,
  listBoards,
  removeBoardElements,
  updateBoardElements,
} from "../be/primitives/boards/service";
import { createObject } from "../be/primitives/objects";
import { MAX_OBJECT_BYTES, mutateObject } from "../be/primitives/write-object";

const OWN_KEY = "af_boards_own_key";
const ORG = "org-boards";
const DRIVE = "drive-boards";

// In-memory agent-fs: raw GET/PUT with If-None-Match / If-Match versions.
const files = new Map<string, { body: string; version: number }>();
// Runs before a guarded write is checked, so a test can race it.
let beforeWrite: ((path: string) => void) | undefined;

const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${OWN_KEY}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const raw = new URL(req.url).pathname.match(/^\/orgs\/[^/]+\/drives\/[^/]+\/files\/(.+)\/raw$/);
    if (!raw) return new Response("not found", { status: 404 });
    const path = decodeURIComponent(raw[1] ?? "");
    if (req.method === "GET") {
      const current = files.get(path);
      if (!current) return new Response("not found", { status: 404 });
      return new Response(current.body, {
        headers: { "x-agent-fs-version": String(current.version) },
      });
    }
    const ifMatch = req.headers.get("if-match");
    if (ifMatch) beforeWrite?.(path);
    const current = files.get(path);
    if (req.headers.get("if-none-match") === "*" && current) {
      return new Response("exists", { status: 409 });
    }
    if (ifMatch && String(current?.version) !== ifMatch) {
      return new Response("version mismatch", { status: 409 });
    }
    const version = (current?.version ?? 0) + 1;
    files.set(path, { body: await req.text(), version });
    return Response.json({ path, version }, { headers: { "x-agent-fs-version": String(version) } });
  },
});

const agentId = crypto.randomUUID();

beforeAll(async () => {
  initDb(":memory:");
  const global = { scope: "global" as const, scopeId: null, isSecret: false };
  await upsertSwarmConfig({
    ...global,
    key: "AGENT_FS_API_URL",
    value: `http://127.0.0.1:${fake.port}`,
  });
  await upsertSwarmConfig({ ...global, key: "AGENT_FS_DEFAULT_ORG_ID", value: ORG });
  await upsertSwarmConfig({ ...global, key: "AGENT_FS_DEFAULT_DRIVE_ID", value: DRIVE });
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key: "AGENT_FS_API_KEY",
    value: OWN_KEY,
    isSecret: true,
  });
});

afterAll(() => {
  fake.stop(true);
  closeDb();
});

beforeEach(async () => {
  files.clear();
  beforeWrite = undefined;
  await getDbClient().run("DELETE FROM primitive_objects");
});

type Scene = { elements: BoardElement[]; swarm?: { id?: string } };
const scene = (path: string): Scene => JSON.parse(files.get(path)?.body ?? "null");
const byId = (s: Scene, id: string) => {
  const element = s.elements.find((e) => e.id === id);
  if (!element) throw new Error(`no element ${id}`);
  return element;
};

// Fields stock Excalidraw 0.18 reads on every element, plus the per-type ones.
// shortcut: a field check, not Excalidraw's own restoreElements; switch when
// @excalidraw/excalidraw lands as a devDependency (embed PR).
const COMMON = [
  "id",
  "type",
  "x",
  "y",
  "width",
  "height",
  "angle",
  "strokeColor",
  "backgroundColor",
  "fillStyle",
  "strokeWidth",
  "strokeStyle",
  "roughness",
  "opacity",
  "groupIds",
  "frameId",
  "index",
  "roundness",
  "seed",
  "version",
  "versionNonce",
  "isDeleted",
  "boundElements",
  "updated",
  "link",
  "locked",
];
const BY_TYPE: Record<string, string[]> = {
  text: [
    "text",
    "originalText",
    "fontSize",
    "fontFamily",
    "textAlign",
    "verticalAlign",
    "containerId",
    "autoResize",
    "lineHeight",
  ],
  arrow: [
    "points",
    "lastCommittedPoint",
    "startBinding",
    "endBinding",
    "startArrowhead",
    "endArrowhead",
    "elbowed",
  ],
};

function expectValidScene(s: Scene) {
  const ids = new Set(s.elements.map((e) => e.id));
  expect(ids.size).toBe(s.elements.length);
  for (const e of s.elements) {
    for (const field of [...COMMON, ...(BY_TYPE[e.type] ?? [])]) {
      expect(e, `${e.type} ${e.id} lacks ${field}`).toHaveProperty(field);
    }
    for (const n of [e.x, e.y, e.width, e.height]) expect(Number.isFinite(n)).toBe(true);
  }
  const indexes = s.elements.map((e) => e.index as string);
  expect(indexes.every((i) => typeof i === "string")).toBe(true);
  expect([...indexes].sort()).toEqual(indexes);
  expect(new Set(indexes).size).toBe(indexes.length);
}

function expectArrowBound(s: Scene, arrowId: string, fromId: string, toId: string) {
  const arrow = byId(s, arrowId);
  expect(arrow.startBinding?.elementId).toBe(fromId);
  expect(arrow.endBinding?.elementId).toBe(toId);
  expect(byId(s, fromId).boundElements).toContainEqual({ type: "arrow", id: arrowId });
  expect(byId(s, toId).boundElements).toContainEqual({ type: "arrow", id: arrowId });
}

const fourShapes = [
  { key: "req", type: "rectangle" as const, label: "Request\nSlack · GitHub", color: "gray" },
  { key: "lead", type: "diamond" as const, label: "Lead triages", color: "orange" },
  { key: "work", type: "ellipse" as const, label: "Worker runs", color: "#a5d8ff" },
  { key: "note", type: "text" as const, label: "Workers talk HTTP only" },
];
const threeArrows = [
  { from: "req", to: "lead", label: "send-task" },
  { from: "lead", to: "work", label: "assign" },
  { from: "work", to: "note" },
];

describe("boards", () => {
  test("create writes shapes, bound labels and two-way bound arrows", async () => {
    const { object, added } = await createBoard({
      agentId,
      path: "/boards/flow.excalidraw",
      title: "Flow",
      shapes: fourShapes,
      arrows: threeArrows,
    });
    expect(object.fileVersion).toBe(1);
    expect(Object.keys(added).sort()).toEqual(
      ["arrows[0]", "arrows[1]", "arrows[2]", "lead", "note", "req", "work"].sort(),
    );
    const s = scene("boards/flow.excalidraw");
    expect(s.swarm).toMatchObject({ id: object.id, kind: "board", title: "Flow" });
    expectValidScene(s);
    // 4 shapes + 3 container labels + 3 arrows + 2 arrow labels.
    expect(s.elements).toHaveLength(12);
    expectArrowBound(s, added["arrows[0]"] ?? "", added.req ?? "", added.lead ?? "");
    expectArrowBound(s, added["arrows[1]"] ?? "", added.lead ?? "", added.work ?? "");
    expectArrowBound(s, added["arrows[2]"] ?? "", added.work ?? "", added.note ?? "");

    for (const key of ["req", "lead", "work"]) {
      const shape = byId(s, added[key] ?? "");
      const ref = shape.boundElements?.find((r) => r.type === "text");
      const label = byId(s, ref?.id ?? "");
      expect(label.containerId).toBe(shape.id);
      // The label fits inside the shape's bound-text box (diamond: half the width).
      const scale = shape.type === "diamond" ? 0.5 : shape.type === "ellipse" ? Math.SQRT1_2 : 1;
      expect(label.width).toBeLessThanOrEqual(shape.width * scale);
      expect(label.height).toBeLessThanOrEqual(shape.height * scale);
    }
    expect(byId(s, added.req ?? "")).toMatchObject({
      strokeColor: "#495057",
      backgroundColor: "#e9ecef",
    });
    expect(byId(s, added.work ?? "").backgroundColor).toBe("#a5d8ff");
    // Auto layout: one row, no overlaps.
    const row = ["req", "lead", "work"].map((k) => byId(s, added[k] ?? ""));
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1] as BoardElement;
      expect((row[i] as BoardElement).x).toBeGreaterThan(prev.x + prev.width);
    }
  });

  test("get summarizes live elements with folded labels and bindings; list filters boards", async () => {
    const { object, added } = await createBoard({
      agentId,
      path: "b/one.excalidraw",
      shapes: fourShapes,
      arrows: threeArrows,
    });
    await createObject({ agentId, kind: "board", path: "c/two.excalidraw" });
    const got = await getBoard({ agentId, id: object.id });
    expect(got.version).toBe(1);
    expect(got.elements).toHaveLength(7);
    const summary = got.elements as Array<{ id: string; text: string | null; boundTo: unknown[] }>;
    expect(summary.find((e) => e.id === added.lead)).toMatchObject({
      text: "Lead triages",
      boundTo: [added["arrows[0]"], added["arrows[1]"]],
    });
    expect(summary.find((e) => e.id === added["arrows[0]"])).toMatchObject({
      text: "send-task",
      boundTo: [added.req, added.lead],
    });
    const full = await getBoard({ agentId, path: "/b/one.excalidraw", detail: "full" });
    expect(full.elements).toHaveLength(12);
    expect((await listBoards({ agentId })).total).toBe(2);
    expect((await listBoards({ agentId, prefix: "b/" })).objects.map((o) => o.id)).toEqual([
      object.id,
    ]);
  });

  test("addElements lays out below existing content and binds to an existing shape", async () => {
    const { object, added } = await createBoard({
      agentId,
      path: "grow.excalidraw",
      shapes: [{ key: "a", type: "rectangle", x: 100, y: 50, label: "A" }],
    });
    const before = byId(scene("grow.excalidraw"), added.a ?? "");
    const next = await addBoardElements({
      agentId,
      id: object.id,
      shapes: [
        { key: "b", type: "rectangle", label: "B" },
        { key: "c", type: "ellipse", label: "C" },
        { key: "d", type: "diamond", label: "D" },
        { key: "e", type: "rectangle", label: "E" },
      ],
      arrows: [{ from: added.a ?? "", to: "b" }],
      layout: "grid",
    });
    expect(next.version).toBe(2);
    const s = scene("grow.excalidraw");
    expectValidScene(s);
    const a = byId(s, added.a ?? "");
    expect(a.version).toBe((before.version ?? 0) + 1);
    expect(a.versionNonce).not.toBe(before.versionNonce);
    expectArrowBound(s, next.added["arrows[0]"] ?? "", a.id, next.added.b ?? "");
    const grid = ["b", "c", "d", "e"].map((k) => byId(s, next.added[k] ?? ""));
    for (const shape of grid) expect(shape.y).toBeGreaterThanOrEqual(a.y + a.height);
    // 2x2 grid: two distinct columns and two distinct rows of cells.
    const [b, c, d] = grid as [BoardElement, BoardElement, BoardElement];
    expect(b.y + b.height / 2).toBeCloseTo(c.y + c.height / 2);
    expect(d.y).toBeGreaterThan(b.y + b.height);
  });

  test("updateElements bumps versions, refits labels and reroutes bound arrows", async () => {
    const { object, added } = await createBoard({
      agentId,
      path: "edit.excalidraw",
      shapes: [
        { key: "a", type: "rectangle", x: 0, y: 0, label: "A" },
        { key: "b", type: "rectangle", x: 400, y: 0, label: "B" },
      ],
      arrows: [{ from: "a", to: "b", label: "go" }],
    });
    const arrowId = added["arrows[0]"] ?? "";
    const before = scene("edit.excalidraw");
    const longLabel = "A much longer label that cannot fit in the default box width";
    const result = await updateBoardElements({
      agentId,
      path: "edit.excalidraw",
      patches: [
        { elementId: added.b ?? "", x: 400, y: 300, color: "green" },
        { elementId: added.a ?? "", label: longLabel },
        { elementId: arrowId, label: "assign" },
      ],
    });
    expect(result.updated).toEqual([added.b, added.a, arrowId]);
    expect(result.version).toBe(2);
    expect(result.object.id).toBe(object.id);
    const s = scene("edit.excalidraw");
    expectValidScene(s);
    for (const id of [added.a, added.b, arrowId]) {
      const was = byId(before, id ?? "");
      const now = byId(s, id ?? "");
      expect(now.version).toBeGreaterThan(was.version ?? 0);
      expect(now.versionNonce).not.toBe(was.versionNonce);
    }
    const a = byId(s, added.a ?? "");
    const aLabel = s.elements.find((e) => e.containerId === a.id) as BoardElement;
    expect(aLabel.text).toBe(longLabel);
    expect(a.width).toBeGreaterThanOrEqual(aLabel.width);
    expect(aLabel.x + aLabel.width / 2).toBeCloseTo(a.x + a.width / 2);
    // B moved down: the arrow now leaves A's bottom and ends at B's top.
    const b = byId(s, added.b ?? "");
    expect(b.strokeColor).toBe("#2f9e44");
    const arrow = byId(s, arrowId);
    const end = arrow.points?.[1] ?? [0, 0];
    expect(arrow.y).toBeCloseTo(a.y + a.height + 4);
    expect(arrow.y + (end[1] ?? 0)).toBeCloseTo(b.y - 4);
    expect(s.elements.find((e) => e.containerId === arrowId)?.text).toBe("assign");
  });

  // Regression: a label created by one patch was invisible to later patches in
  // the same call, so a second set duplicated it and arrow re-routing left it behind.
  describe("updateElements: a label set earlier in the call is visible to later patches", () => {
    async function board(path: string) {
      const { added } = await createBoard({
        agentId,
        path,
        shapes: [
          { key: "a", type: "rectangle", x: 0, y: 0 },
          { key: "b", type: "rectangle", x: 400, y: 0 },
        ],
        arrows: [{ from: "a", to: "b" }],
      });
      return { a: added.a ?? "", b: added.b ?? "", arrow: added["arrows[0]"] ?? "" };
    }

    // Exactly one live bound text with `text` (or none), with matching two-way refs.
    function expectLabel(s: Scene, containerId: string, text: string | null) {
      const texts = s.elements.filter((e) => e.type === "text" && e.containerId === containerId);
      const live = texts.filter((e) => !e.isDeleted);
      const refs = (byId(s, containerId).boundElements ?? []).filter((r) => r.type === "text");
      if (text === null) {
        expect(live).toHaveLength(0);
        expect(refs).toHaveLength(0);
        return undefined;
      }
      expect(live.map((e) => e.text)).toEqual([text]);
      expect(refs).toEqual([{ type: "text", id: live[0]?.id ?? "" }]);
      return live[0] as BoardElement;
    }

    function expectArrowLabelCentered(s: Scene, arrowId: string, label: BoardElement) {
      const arrow = byId(s, arrowId);
      const end = arrow.points?.[1] ?? [0, 0];
      expect(label.x + label.width / 2).toBeCloseTo(arrow.x + (end[0] ?? 0) / 2);
      expect(label.y + label.height / 2).toBeCloseTo(arrow.y + (end[1] ?? 0) / 2);
    }

    for (const order of ["label then move", "move then label"] as const) {
      test(`arrow label follows a moved end (${order})`, async () => {
        const ids = await board("reroute.excalidraw");
        const label = { elementId: ids.arrow, label: "go" };
        const move = { elementId: ids.b, y: 600 };
        await updateBoardElements({
          agentId,
          path: "reroute.excalidraw",
          patches: order === "label then move" ? [label, move] : [move, label],
        });
        const s = scene("reroute.excalidraw");
        expectValidScene(s);
        const text = expectLabel(s, ids.arrow, "go") as BoardElement;
        expectArrowLabelCentered(s, ids.arrow, text);
        expect(text.y + text.height / 2).toBeGreaterThan(300);
      });
    }

    test("a shape label set, then moved and resized, stays centered", async () => {
      const ids = await board("shape-move.excalidraw");
      await updateBoardElements({
        agentId,
        path: "shape-move.excalidraw",
        patches: [
          { elementId: ids.a, label: "new" },
          { elementId: ids.a, x: 50, y: 500, width: 300 },
        ],
      });
      const s = scene("shape-move.excalidraw");
      expectValidScene(s);
      const a = byId(s, ids.a);
      const text = expectLabel(s, ids.a, "new") as BoardElement;
      expect(text.x + text.width / 2).toBeCloseTo(a.x + a.width / 2);
      expect(text.y + text.height / 2).toBeCloseTo(a.y + a.height / 2);
    });

    for (const target of ["a", "arrow"] as const) {
      const kind = target === "a" ? "shape" : "arrow";
      test(`setting a ${kind} label twice keeps one live text`, async () => {
        const ids = await board(`twice-${target}.excalidraw`);
        const result = await updateBoardElements({
          agentId,
          path: `twice-${target}.excalidraw`,
          patches: [
            { elementId: ids[target], label: "first" },
            { elementId: ids[target], label: "second" },
          ],
        });
        expect(result.version).toBe(2);
        const s = scene(`twice-${target}.excalidraw`);
        expectValidScene(s);
        const text = expectLabel(s, ids[target], "second") as BoardElement;
        expect(text.version).toBe(1);
        if (target === "arrow") expectArrowLabelCentered(s, ids.arrow, text);
        expect((await getBoard({ agentId, path: `twice-${target}.excalidraw` })).elements).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: ids[target], text: "second" })]),
        );
      });

      test(`setting then clearing a new ${kind} label leaves no text, not even a tombstone`, async () => {
        const ids = await board(`clear-${target}.excalidraw`);
        await updateBoardElements({
          agentId,
          path: `clear-${target}.excalidraw`,
          patches: [
            { elementId: ids[target], label: "temp" },
            { elementId: ids[target], label: "" },
          ],
        });
        const s = scene(`clear-${target}.excalidraw`);
        expectValidScene(s);
        expectLabel(s, ids[target], null);
        expect(s.elements.filter((e) => e.containerId === ids[target])).toHaveLength(0);
      });

      test(`clearing a stored ${kind} label then setting a new one keeps one live text`, async () => {
        const ids = await board(`reset-${target}.excalidraw`);
        await updateBoardElements({
          agentId,
          path: `reset-${target}.excalidraw`,
          patches: [{ elementId: ids[target], label: "old" }],
        });
        const oldId = expectLabel(scene(`reset-${target}.excalidraw`), ids[target], "old")?.id;
        await updateBoardElements({
          agentId,
          path: `reset-${target}.excalidraw`,
          patches: [
            { elementId: ids[target], label: "" },
            { elementId: ids[target], label: "new" },
            { elementId: ids[target], label: "newer" },
          ],
        });
        const s = scene(`reset-${target}.excalidraw`);
        expectValidScene(s);
        const text = expectLabel(s, ids[target], "newer") as BoardElement;
        expect(text.id).not.toBe(oldId);
        expect(byId(s, oldId ?? "").isDeleted).toBe(true);
      });
    }
  });

  test("updateElements refuses bad patches and writes nothing", async () => {
    const { object, added } = await createBoard({
      agentId,
      path: "refuse.excalidraw",
      shapes: [
        { key: "a", type: "rectangle", label: "A" },
        { key: "b", type: "rectangle", label: "B" },
      ],
      arrows: [{ from: "a", to: "b" }],
    });
    const s = scene("refuse.excalidraw");
    const label = s.elements.find((e) => e.containerId === added.a);
    const refusals: Array<[unknown, string]> = [
      [{ elementId: "nope" }, "no live element 'nope'"],
      [{ elementId: added["arrows[0]"], x: 5 }, "arrows follow the shapes"],
      [{ elementId: label?.id }, "is the label of"],
      [{ elementId: added.a, color: "chartreuse" }, "not a palette name"],
    ];
    for (const [patch, message] of refusals) {
      await expect(
        updateBoardElements({ agentId, id: object.id, patches: [patch as never] }),
      ).rejects.toThrow(message);
    }
    expect(files.get("refuse.excalidraw")?.version).toBe(1);
  });

  test("removeElements sets isDeleted, takes labels along and unbinds arrows", async () => {
    const { object, added } = await createBoard({
      agentId,
      path: "rm.excalidraw",
      shapes: [
        { key: "a", type: "rectangle", label: "A" },
        { key: "b", type: "rectangle", label: "B" },
        { key: "c", type: "rectangle", label: "C" },
      ],
      arrows: [
        { from: "a", to: "b", label: "ab" },
        { from: "b", to: "c" },
      ],
    });
    const removed = await removeBoardElements({
      agentId,
      id: object.id,
      elementIds: [added.a ?? "", added["arrows[1]"] ?? ""],
    });
    expect(removed.removed).toEqual([added.a, added["arrows[1]"]]);
    const s = scene("rm.excalidraw");
    expectValidScene(s);
    const a = byId(s, added.a ?? "");
    expect(a.isDeleted).toBe(true);
    expect(s.elements.find((e) => e.containerId === a.id)?.isDeleted).toBe(true);
    const ab = byId(s, added["arrows[0]"] ?? "");
    expect(ab.isDeleted).toBe(false);
    expect(ab.startBinding).toBeNull();
    expect(ab.endBinding?.elementId).toBe(added.b);
    expect(byId(s, added.c ?? "").boundElements?.some((r) => r.id === added["arrows[1]"])).toBe(
      false,
    );
    // Summaries drop deleted elements.
    const got = await getBoard({ agentId, id: object.id });
    expect(got.elements.map((e) => e.id).sort()).toEqual(
      [added.b, added.c, added["arrows[0]"]].sort() as string[],
    );
    await expect(
      removeBoardElements({ agentId, id: object.id, elementIds: [added.a ?? ""] }),
    ).rejects.toThrow("no live element");
  });

  test("invalid element input refuses before any write", async () => {
    await expect(
      createBoard({
        agentId,
        path: "bad.excalidraw",
        shapes: [{ key: "a", type: "rectangle" }],
        arrows: [{ from: "a", to: "ghost" }],
      }),
    ).rejects.toThrow("'ghost' is not a shape key");
    expect(files.has("bad.excalidraw")).toBe(false);
    const { object } = await createBoard({ agentId, path: "bad.excalidraw" });
    const cases: Array<[Parameters<typeof addBoardElements>[0], string]> = [
      [{ agentId, id: object.id, shapes: [{ type: "text" }] }, "needs a non-empty label"],
      [
        {
          agentId,
          id: object.id,
          shapes: [
            { key: "x", type: "rectangle" },
            { key: "x", type: "ellipse" },
          ],
        },
        "duplicate key",
      ],
      [
        {
          agentId,
          id: object.id,
          shapes: [{ key: "x", type: "rectangle" }],
          arrows: [{ from: "x", to: "x" }],
        },
        "two different shapes",
      ],
      [{ agentId, id: object.id }, "at least one shape or arrow"],
      [{ agentId, id: "no-such-board", shapes: [{ type: "rectangle" }] }, "no object with id"],
      [{ agentId, shapes: [{ type: "rectangle" }] }, "pass `id` or `path`"],
    ];
    for (const [input, message] of cases) {
      await expect(addBoardElements(input)).rejects.toThrow(message);
    }
    expect(files.get("bad.excalidraw")?.version).toBe(1);
  });

  test("a stock Excalidraw save that dropped swarm.id still resolves by path and heals", async () => {
    const { object } = await createBoard({ agentId, path: "stock.excalidraw" });
    files.set("stock.excalidraw", {
      body: JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw.com",
        elements: [],
      }),
      version: 2,
    });
    const got = await getBoard({ agentId, path: "stock.excalidraw" });
    expect(got.object.id).toBe(object.id);
    const next = await addBoardElements({
      agentId,
      path: "stock.excalidraw",
      shapes: [{ type: "rectangle", label: "back" }],
    });
    expect(next.version).toBe(3);
    expect(scene("stock.excalidraw").swarm?.id).toBe(object.id);
  });

  test("a 409 re-reads and re-applies, so a concurrent write merges", async () => {
    const { object } = await createBoard({ agentId, path: "race.excalidraw" });
    let raced = false;
    beforeWrite = (path) => {
      if (raced) return;
      raced = true;
      // Another writer lands one element between our read and our write.
      const current = files.get(path);
      const s = JSON.parse(current?.body ?? "{}");
      s.elements.push({
        id: "theirs",
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        index: "a0",
      });
      files.set(path, { body: JSON.stringify(s), version: (current?.version ?? 0) + 1 });
    };
    const result = await addBoardElements({
      agentId,
      id: object.id,
      shapes: [{ key: "mine", type: "rectangle", label: "mine" }],
    });
    expect(result.version).toBe(3);
    const ids = scene("race.excalidraw").elements.map((e) => e.id);
    expect(ids).toContain("theirs");
    expect(ids).toContain(result.added.mine);
    const row = await getDbClient().get<{ fileVersion: number }>(
      "SELECT fileVersion FROM primitive_objects WHERE id = ?",
      [object.id],
    );
    expect(row?.fileVersion).toBe(3);
  });

  test("the 4th conflict in a row refuses and writes nothing of ours", async () => {
    const { object } = await createBoard({ agentId, path: "busy.excalidraw" });
    let conflicts = 0;
    beforeWrite = (path) => {
      conflicts += 1;
      const current = files.get(path);
      if (current) files.set(path, { ...current, version: current.version + 1 });
    };
    await expect(
      addBoardElements({ agentId, id: object.id, shapes: [{ type: "rectangle" }] }),
    ).rejects.toThrow("concurrent writers");
    expect(conflicts).toBe(4);
    expect(scene("busy.excalidraw").elements).toEqual([]);
  });

  test("a write over the size cap refuses", async () => {
    const { object } = await createBoard({ agentId, path: "big.excalidraw" });
    await expect(
      mutateObject({
        agentId,
        id: object.id,
        kind: "board",
        message: "too big",
        mutate: (content) => {
          content.padding = "x".repeat(MAX_OBJECT_BYTES);
        },
      }),
    ).rejects.toThrow("would exceed");
    expect(files.get("big.excalidraw")?.version).toBe(1);
  });

  test("text measuring scales with length, lines and font size", () => {
    const one = measureText("Lead", 20);
    expect(measureText("Lead triages", 20).width).toBeGreaterThan(one.width);
    expect(measureText("Lead\ntriages", 20).height).toBe(Math.ceil(2 * 20 * 1.25));
    expect(measureText("Lead", 40).width).toBeGreaterThanOrEqual(2 * one.width - 1);
    // Narrow and wide glyphs differ (a real table, not a monospace fallback).
    expect(measureText("iiii", 20).width).toBeLessThan(measureText("WWWW", 20).width);
  });
});
