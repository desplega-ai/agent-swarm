import { generateNKeysBetween } from "fractional-indexing";
import { ObjectsError } from "../objects";
import metrics from "./excalifont-metrics.json";

/**
 * Raw Excalidraw element JSON, built without a browser or the Excalidraw
 * package. Text sizes come from a committed Excalifont advance-width table
 * (scripts/gen-excalifont-metrics.ts), so they are estimates: the embed
 * re-measures on open (`restoreElements(…, { refreshDimensions: true })`).
 */

export const SHAPE_TYPES = ["rectangle", "ellipse", "diamond", "text"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];
export const LAYOUTS = ["row", "column", "grid"] as const;
export type Layout = (typeof LAYOUTS)[number];

/** Open-color pairs, Excalidraw's own palette: [stroke, background]. */
export const PALETTE: Readonly<Record<string, readonly [string, string]>> = {
  blue: ["#1971c2", "#a5d8ff"],
  green: ["#2f9e44", "#b2f2bb"],
  yellow: ["#f08c00", "#ffec99"],
  red: ["#e03131", "#ffc9c9"],
  violet: ["#6741d9", "#d0bfff"],
  orange: ["#e8590c", "#ffd8a8"],
  gray: ["#495057", "#e9ecef"],
  teal: ["#0c8599", "#96f2d7"],
};

export type ShapeInput = {
  key?: string;
  type: ShapeType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  color?: string;
};
export type ArrowInput = { from: string; to: string; label?: string };
export type ElementPatch = {
  elementId: string;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
};

type Binding = { elementId: string; focus: number; gap: number };
type BoundRef = { id: string; type: string };

/** One Excalidraw element. Unknown fields from stock Excalidraw pass through. */
export type BoardElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version?: number;
  versionNonce?: number;
  updated?: number;
  isDeleted?: boolean;
  index?: string | null;
  boundElements?: BoundRef[] | null;
  containerId?: string | null;
  startBinding?: Binding | null;
  endBinding?: Binding | null;
  text?: string;
  originalText?: string;
  fontSize?: number;
  points?: number[][];
  strokeColor?: string;
  backgroundColor?: string;
  [key: string]: unknown;
};

export type Scene = { elements: BoardElement[]; [key: string]: unknown };

export type ElementSummary = {
  id: string;
  type: string;
  text: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Arrow: `[from, to]` element ids (null when unbound). Shape: ids of its bound arrows. */
  boundTo: Array<string | null>;
};

const STROKE = "#1e1e1e";
const FONT_FAMILY_EXCALIFONT = 5;
const LINE_HEIGHT = metrics.lineHeight;
const SHAPE_FONT_SIZE = 20;
const ARROW_FONT_SIZE = 16;
// Excalidraw's BOUND_TEXT_PADDING, plus breathing room around a label.
const BOUND_TEXT_PADDING = 5;
const LABEL_MARGIN = 20;
const DEFAULT_SIZE = { width: 200, height: 80 };
const BINDING_GAP = 4;
const LAYOUT_GAP = 80;
// Sum-of-advances is within ~3% of a real measure (kerning); round up past it.
const WIDTH_SAFETY = 1.05;
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

const widths = metrics.widths as Record<string, number>;

/** Estimated Excalifont text box, as Excalidraw lays it out (no wrapping). */
export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  const em = Math.max(
    ...lines.map((line) =>
      [...line].reduce((sum, char) => {
        const known = widths[char];
        if (known !== undefined) return sum + known;
        // CJK and emoji render in Excalidraw's fallback fonts at about one em.
        return sum + ((char.codePointAt(0) ?? 0) >= 0x2e80 ? metrics.wide : metrics.fallback);
      }, 0),
    ),
  );
  return {
    width: Math.max(1, Math.ceil(em * fontSize * WIDTH_SAFETY)),
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
  };
}

const randomInt = (): number => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 1) >>> 1 || 1;

function newElementId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  return Array.from(bytes, (b) => ID_ALPHABET[b & 63]).join("");
}

function colorPair(color: string | undefined, where: string): [string, string] | undefined {
  if (color === undefined) return undefined;
  const named = Object.hasOwn(PALETTE, color) ? PALETTE[color] : undefined;
  if (named) return [named[0], named[1]];
  if (HEX.test(color)) return [STROKE, color];
  throw new ObjectsError(
    `${where}: color '${color}' is not a palette name (${Object.keys(PALETTE).join(", ")}) or #rrggbb`,
  );
}

function baseElement(
  type: string,
  geometry: { x: number; y: number; width: number; height: number },
  now: number,
): BoardElement {
  return {
    id: newElementId(),
    type,
    ...geometry,
    angle: 0,
    strokeColor: STROKE,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness:
      type === "rectangle"
        ? { type: 3 }
        : type === "diamond" || type === "arrow"
          ? { type: 2 }
          : null,
    seed: randomInt(),
    version: 1,
    versionNonce: randomInt(),
    isDeleted: false,
    boundElements: [],
    updated: now,
    link: null,
    locked: false,
  };
}

function textElement(
  text: string,
  fontSize: number,
  at: { x: number; y: number },
  containerId: string | null,
  now: number,
): BoardElement {
  const size = measureText(text, fontSize);
  return {
    ...baseElement("text", { ...at, ...size }, now),
    boundElements: null,
    text,
    originalText: text,
    fontSize,
    fontFamily: FONT_FAMILY_EXCALIFONT,
    textAlign: containerId ? "center" : "left",
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  };
}

/** Smallest container that fits a label inside Excalidraw's bound-text box for that shape. */
function fitContainer(
  type: string,
  label: { width: number; height: number },
  min: { width: number; height: number },
): { width: number; height: number } {
  const inner = {
    width: label.width + 2 * BOUND_TEXT_PADDING + LABEL_MARGIN,
    height: label.height + 2 * BOUND_TEXT_PADDING + LABEL_MARGIN,
  };
  // Excalidraw's getBoundTextMaxWidth: an ellipse fits w/2·√2, a diamond w/2.
  const scale = type === "ellipse" ? Math.SQRT2 : type === "diamond" ? 2 : 1;
  return {
    width: Math.max(min.width, Math.ceil(inner.width * scale)),
    height: Math.max(min.height, Math.ceil(inner.height * scale)),
  };
}

const center = (e: BoardElement) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });

function centerLabel(container: BoardElement, label: BoardElement): void {
  if (container.type === "arrow") {
    const points = container.points ?? [[0, 0]];
    const first = points[0] ?? [0, 0];
    const last = points[points.length - 1] ?? first;
    label.x = container.x + ((first[0] ?? 0) + (last[0] ?? 0)) / 2 - label.width / 2;
    label.y = container.y + ((first[1] ?? 0) + (last[1] ?? 0)) / 2 - label.height / 2;
    return;
  }
  const c = center(container);
  label.x = c.x - label.width / 2;
  label.y = c.y - label.height / 2;
}

type Box = { x: number; y: number; width: number; height: number; bound: boolean };

/** Straight arrow between the facing sides of two boxes, on the dominant axis. */
function route(from: Box, to: Box): { start: [number, number]; end: [number, number] } {
  const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const gapFrom = from.bound ? BINDING_GAP : 0;
  const gapTo = to.bound ? BINDING_GAP : 0;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const s = dx >= 0 ? 1 : -1;
    return {
      start: [a.x + s * (from.width / 2 + gapFrom), a.y],
      end: [b.x - s * (to.width / 2 + gapTo), b.y],
    };
  }
  const s = dy >= 0 ? 1 : -1;
  return {
    start: [a.x, a.y + s * (from.height / 2 + gapFrom)],
    end: [b.x, b.y - s * (to.height / 2 + gapTo)],
  };
}

function placeArrow(arrow: BoardElement, from: Box, to: Box): void {
  const { start, end } = route(from, to);
  arrow.x = start[0];
  arrow.y = start[1];
  arrow.points = [
    [0, 0],
    [end[0] - start[0], end[1] - start[1]],
  ];
  arrow.width = Math.abs(end[0] - start[0]);
  arrow.height = Math.abs(end[1] - start[1]);
}

function boxOf(element: BoardElement): Box {
  return { x: element.x, y: element.y, width: element.width, height: element.height, bound: true };
}

/** An arrow's unbound end as a zero-size box at its current absolute point. */
function pointBox(arrow: BoardElement, end: "start" | "end"): Box {
  const points = arrow.points ?? [[0, 0]];
  const p = (end === "start" ? points[0] : points[points.length - 1]) ?? [0, 0];
  return { x: arrow.x + (p[0] ?? 0), y: arrow.y + (p[1] ?? 0), width: 0, height: 0, bound: false };
}

export function parseScene(content: unknown, path: string): Scene {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new ObjectsError(`'${path}' is not an Excalidraw scene (not a JSON object)`);
  }
  const scene = content as Scene;
  if (scene.elements === undefined) scene.elements = [];
  if (!Array.isArray(scene.elements)) {
    throw new ObjectsError(`'${path}' is not an Excalidraw scene (elements is not an array)`);
  }
  for (const element of scene.elements) {
    if (!element || typeof element.id !== "string" || typeof element.type !== "string") {
      throw new ObjectsError(`'${path}' has an element without a string id and type`);
    }
  }
  return scene;
}

const live = (scene: Scene) => scene.elements.filter((e) => !e.isDeleted);

function liveById(scene: Scene): Map<string, BoardElement> {
  return new Map(live(scene).map((e) => [e.id, e]));
}

const labelOf = (scene: Scene, container: BoardElement): BoardElement | undefined =>
  live(scene).find((e) => e.type === "text" && e.containerId === container.id);

function bump(elements: Iterable<BoardElement>, now: number): void {
  for (const element of new Set(elements)) {
    element.version = (typeof element.version === "number" ? element.version : 0) + 1;
    element.versionNonce = randomInt();
    element.updated = now;
  }
}

function addRef(element: BoardElement, ref: BoundRef): void {
  const refs = Array.isArray(element.boundElements) ? element.boundElements : [];
  if (!refs.some((r) => r.id === ref.id)) refs.push(ref);
  element.boundElements = refs;
}

function dropRef(element: BoardElement, id: string): void {
  if (Array.isArray(element.boundElements)) {
    element.boundElements = element.boundElements.filter((r) => r.id !== id);
  }
}

/** Give appended elements fractional `index` keys above every existing one. */
function assignIndexes(scene: Scene, added: BoardElement[]): void {
  if (added.length === 0) return;
  const existing = scene.elements
    .filter((e) => !added.includes(e))
    .map((e) => e.index)
    .filter((i): i is string => typeof i === "string")
    .sort();
  let keys: string[];
  try {
    keys = generateNKeysBetween(existing[existing.length - 1] ?? null, null, added.length);
  } catch {
    // An invalid stored index: Excalidraw repairs order on load (syncInvalidIndices).
    keys = generateNKeysBetween(null, null, added.length);
  }
  added.forEach((element, i) => {
    element.index = keys[i] ?? null;
  });
}

/** Where shapes without coordinates start: below the scene's live content. */
function layoutOrigin(scene: Scene): { x: number; y: number } {
  const elements = live(scene);
  if (elements.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...elements.map((e) => e.x)),
    y: Math.max(...elements.map((e) => e.y + e.height)) + LAYOUT_GAP,
  };
}

function layoutPositions(
  sizes: Array<{ width: number; height: number }>,
  layout: Layout,
  origin: { x: number; y: number },
): Array<{ x: number; y: number }> {
  if (layout === "grid") {
    const cols = Math.max(1, Math.ceil(Math.sqrt(sizes.length)));
    const cellW = Math.max(...sizes.map((s) => s.width), 0);
    const cellH = Math.max(...sizes.map((s) => s.height), 0);
    return sizes.map((s, i) => ({
      x: origin.x + (i % cols) * (cellW + LAYOUT_GAP) + (cellW - s.width) / 2,
      y: origin.y + Math.floor(i / cols) * (cellH + LAYOUT_GAP) + (cellH - s.height) / 2,
    }));
  }
  let cursor = 0;
  return sizes.map((s) => {
    const at =
      layout === "row"
        ? { x: origin.x + cursor, y: origin.y }
        : { x: origin.x, y: origin.y + cursor };
    cursor += (layout === "row" ? s.width : s.height) + LAYOUT_GAP;
    return at;
  });
}

/**
 * Append shapes and arrows to `scene` in place. Arrow ends name a shape `key`
 * from this call or an existing element id; both ends are bound two-way.
 * Returns `added`: each shape's key (or `shapes[i]`) and `arrows[i]` → element id.
 */
export function addElements(
  scene: Scene,
  input: { shapes?: ShapeInput[]; arrows?: ArrowInput[]; layout?: Layout },
  now = Date.now(),
): Record<string, string> {
  const shapes = input.shapes ?? [];
  const arrows = input.arrows ?? [];
  const byKey = new Map<string, BoardElement>();
  const keys = new Set<string>();
  const added: Record<string, string> = {};
  const appended: BoardElement[] = [];
  const touched: BoardElement[] = [];
  const existing = liveById(scene);

  // Size every shape first, so the layout can use real sizes.
  const planned = shapes.map((shape, i) => {
    const where = `shapes[${i}]`;
    if (shape.key !== undefined) {
      if (keys.has(shape.key)) throw new ObjectsError(`${where}: duplicate key '${shape.key}'`);
      keys.add(shape.key);
    }
    const label = shape.label ?? "";
    if (shape.type === "text" && label.trim() === "") {
      throw new ObjectsError(`${where}: a text shape needs a non-empty label`);
    }
    const colors = colorPair(shape.color, where);
    const min = {
      width: shape.width ?? DEFAULT_SIZE.width,
      height: shape.height ?? DEFAULT_SIZE.height,
    };
    const labelSize = label ? measureText(label, SHAPE_FONT_SIZE) : { width: 0, height: 0 };
    const size = shape.type === "text" ? labelSize : fitContainer(shape.type, labelSize, min);
    return { shape, label, colors, size };
  });

  const auto = planned.filter((p) => p.shape.x === undefined || p.shape.y === undefined);
  const positions = layoutPositions(
    auto.map((p) => p.size),
    input.layout ?? "row",
    layoutOrigin(scene),
  );

  for (const [i, p] of planned.entries()) {
    const slot = auto.indexOf(p);
    const at = slot >= 0 ? positions[slot] : undefined;
    const x = p.shape.x ?? at?.x ?? 0;
    const y = p.shape.y ?? at?.y ?? 0;
    let element: BoardElement;
    if (p.shape.type === "text") {
      element = textElement(p.label, SHAPE_FONT_SIZE, { x, y }, null, now);
      if (p.colors) element.strokeColor = p.colors[0];
      appended.push(element);
    } else {
      element = baseElement(p.shape.type, { x, y, ...p.size }, now);
      if (p.colors) [element.strokeColor, element.backgroundColor] = p.colors;
      appended.push(element);
      if (p.label) {
        const text = textElement(p.label, SHAPE_FONT_SIZE, { x, y }, element.id, now);
        centerLabel(element, text);
        addRef(element, { type: "text", id: text.id });
        appended.push(text);
      }
    }
    if (p.shape.key !== undefined) byKey.set(p.shape.key, element);
    added[p.shape.key ?? `shapes[${i}]`] = element.id;
  }

  const resolve = (ref: string, where: string): BoardElement => {
    const element = byKey.get(ref) ?? existing.get(ref);
    if (!element) {
      throw new ObjectsError(
        `${where}: '${ref}' is not a shape key in this call or a live element id`,
      );
    }
    if (element.type === "arrow" || element.type === "line" || element.containerId) {
      throw new ObjectsError(
        `${where}: '${ref}' is a ${element.containerId ? "label" : element.type}; bind arrows to shapes`,
      );
    }
    return element;
  };

  for (const [i, input] of arrows.entries()) {
    const where = `arrows[${i}]`;
    const from = resolve(input.from, `${where}.from`);
    const to = resolve(input.to, `${where}.to`);
    if (from === to) throw new ObjectsError(`${where}: an arrow needs two different shapes`);
    const arrow: BoardElement = {
      ...baseElement("arrow", { x: 0, y: 0, width: 0, height: 0 }, now),
      points: [],
      lastCommittedPoint: null,
      startBinding: { elementId: from.id, focus: 0, gap: BINDING_GAP },
      endBinding: { elementId: to.id, focus: 0, gap: BINDING_GAP },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    };
    placeArrow(arrow, boxOf(from), boxOf(to));
    addRef(from, { type: "arrow", id: arrow.id });
    addRef(to, { type: "arrow", id: arrow.id });
    for (const end of [from, to]) if (!appended.includes(end)) touched.push(end);
    appended.push(arrow);
    if (input.label) {
      const text = textElement(input.label, ARROW_FONT_SIZE, { x: 0, y: 0 }, arrow.id, now);
      text.textAlign = "center";
      text.verticalAlign = "middle";
      centerLabel(arrow, text);
      addRef(arrow, { type: "text", id: text.id });
      appended.push(text);
    }
    added[`arrows[${i}]`] = arrow.id;
  }

  scene.elements.push(...appended);
  assignIndexes(scene, appended);
  bump(touched, now);
  return added;
}

/** Re-route every live arrow bound to `element` from its ends' current geometry. */
function rerouteArrows(scene: Scene, element: BoardElement, touched: BoardElement[]): void {
  const byId = liveById(scene);
  for (const arrow of live(scene)) {
    if (arrow.type !== "arrow") continue;
    const startId = arrow.startBinding?.elementId;
    const endId = arrow.endBinding?.elementId;
    if (startId !== element.id && endId !== element.id) continue;
    const start = startId ? byId.get(startId) : undefined;
    const end = endId ? byId.get(endId) : undefined;
    // shortcut: re-routing straightens a multi-point arrow; keep bends when hand-drawn routes matter.
    placeArrow(
      arrow,
      start ? boxOf(start) : pointBox(arrow, "start"),
      end ? boxOf(end) : pointBox(arrow, "end"),
    );
    touched.push(arrow);
    const label = labelOf(scene, arrow);
    if (label) {
      centerLabel(arrow, label);
      touched.push(label);
    }
  }
}

/**
 * Set or clear `element`'s label. A new label joins `scene.elements` at once,
 * so later patches in the same call (and arrow re-routing) see it; it is also
 * recorded in `appended` so the caller indexes it once at the end.
 */
function setLabel(
  scene: Scene,
  element: BoardElement,
  label: string,
  now: number,
  touched: BoardElement[],
  appended: BoardElement[],
): void {
  if (element.type === "text") {
    if (label.trim() === "")
      throw new ObjectsError(`${element.id}: a text element needs a non-empty label`);
    const size = measureText(label, element.fontSize ?? SHAPE_FONT_SIZE);
    Object.assign(element, { text: label, originalText: label, ...size });
    return;
  }
  const existing = labelOf(scene, element);
  if (label === "") {
    if (existing) {
      dropRef(element, existing.id);
      if (appended.includes(existing)) {
        // Created earlier in this call and never persisted: drop it, no tombstone.
        scene.elements.splice(scene.elements.indexOf(existing), 1);
        appended.splice(appended.indexOf(existing), 1);
      } else {
        existing.isDeleted = true;
        touched.push(existing);
      }
    }
    return;
  }
  const fontSize = element.type === "arrow" ? ARROW_FONT_SIZE : SHAPE_FONT_SIZE;
  if (existing) {
    Object.assign(existing, {
      text: label,
      originalText: label,
      ...measureText(label, existing.fontSize ?? fontSize),
    });
    touched.push(existing);
    return;
  }
  const text = textElement(label, fontSize, { x: element.x, y: element.y }, element.id, now);
  text.textAlign = "center";
  text.verticalAlign = "middle";
  addRef(element, { type: "text", id: text.id });
  scene.elements.push(text);
  appended.push(text);
}

/** Apply patches in place. Returns the patched ids. */
export function updateElements(scene: Scene, patches: ElementPatch[], now = Date.now()): string[] {
  const byId = liveById(scene);
  const touched: BoardElement[] = [];
  const appended: BoardElement[] = [];
  for (const [i, patch] of patches.entries()) {
    const where = `patches[${i}]`;
    const element = byId.get(patch.elementId);
    if (!element) throw new ObjectsError(`${where}: no live element '${patch.elementId}'`);
    if (element.type === "text" && element.containerId) {
      throw new ObjectsError(
        `${where}: '${element.id}' is the label of '${element.containerId}'; patch that element`,
      );
    }
    const moves = [patch.x, patch.y, patch.width, patch.height].some((v) => v !== undefined);
    if (element.type === "arrow" && moves) {
      throw new ObjectsError(
        `${where}: arrows follow the shapes they bind; move or resize the shapes`,
      );
    }
    touched.push(element);
    const colors = colorPair(patch.color, where);
    if (colors) {
      element.strokeColor = colors[0];
      if (element.type !== "text" && element.type !== "arrow") element.backgroundColor = colors[1];
    }
    if (patch.x !== undefined) element.x = patch.x;
    if (patch.y !== undefined) element.y = patch.y;
    if (patch.width !== undefined) element.width = patch.width;
    if (patch.height !== undefined) element.height = patch.height;
    if (patch.label !== undefined) setLabel(scene, element, patch.label, now, touched, appended);
    const label = element.type === "text" ? undefined : labelOf(scene, element);
    if (label) {
      // A smaller explicit size still has to fit the label.
      if (element.type !== "arrow") {
        Object.assign(element, fitContainer(element.type, label, element));
      }
      centerLabel(element, label);
      touched.push(label);
    }
    if (element.type !== "arrow" && (moves || patch.label !== undefined))
      rerouteArrows(scene, element, touched);
  }
  assignIndexes(scene, appended);
  bump(
    touched.filter((e) => !appended.includes(e)),
    now,
  );
  return patches.map((p) => p.elementId);
}

/**
 * Mark elements deleted in place (`isDeleted: true`, the Excalidraw
 * convention). A shape takes its label with it and unbinds its arrows; an
 * arrow leaves its shapes' `boundElements`.
 */
export function removeElements(scene: Scene, elementIds: string[], now = Date.now()): string[] {
  const byId = liveById(scene);
  const unknown = elementIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new ObjectsError(`no live element: ${unknown.join(", ")}`);
  const touched: BoardElement[] = [];
  for (const id of new Set(elementIds)) {
    const element = byId.get(id);
    if (!element || element.isDeleted) continue;
    element.isDeleted = true;
    touched.push(element);
    if (element.containerId) {
      const container = byId.get(element.containerId);
      if (container) {
        dropRef(container, element.id);
        touched.push(container);
      }
    }
    const label = labelOf(scene, element);
    if (label) {
      label.isDeleted = true;
      touched.push(label);
    }
    if (element.type === "arrow") {
      for (const binding of [element.startBinding, element.endBinding]) {
        const end = binding ? byId.get(binding.elementId) : undefined;
        if (end) {
          dropRef(end, element.id);
          touched.push(end);
        }
      }
      continue;
    }
    for (const arrow of live(scene)) {
      if (arrow.type !== "arrow") continue;
      if (arrow.startBinding?.elementId === element.id) arrow.startBinding = null;
      else if (arrow.endBinding?.elementId === element.id) arrow.endBinding = null;
      else continue;
      touched.push(arrow);
    }
  }
  bump(touched, now);
  return [...new Set(elementIds)];
}

/** One line per live element; a shape's label folds into its `text`. */
export function summarize(scene: Scene): ElementSummary[] {
  const elements = live(scene);
  const labels = new Map(
    elements
      .filter((e) => e.type === "text" && e.containerId)
      .map((e) => [e.containerId, e.text ?? ""]),
  );
  const liveIds = new Set(elements.map((e) => e.id));
  return elements
    .filter((e) => !(e.type === "text" && e.containerId))
    .map((e) => ({
      id: e.id,
      type: e.type,
      text: e.type === "text" ? (e.text ?? "") : (labels.get(e.id) ?? null),
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      boundTo:
        e.type === "arrow"
          ? [e.startBinding?.elementId ?? null, e.endBinding?.elementId ?? null]
          : (e.boundElements ?? [])
              .filter((r) => r.type === "arrow" && liveIds.has(r.id))
              .map((r) => r.id),
    }));
}
