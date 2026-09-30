// Comb presence: who else is on the drive, on which file, what they select,
// and where their pointer is. One realtime room per drive
// (`presence:comb:<org>:<drive>`, room "default"); each tab publishes one
// `PresenceData` object and the server fans out every peer's latest object.
//
// Peer data is client-asserted and untrusted: `parsePeer` validates and
// clamps it. The server stamps only the connection id and kind.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { deriveStorageKey } from "../../hooks/use-dismissible-card-key";
import { QUOTE_CONTEXT_CHARS } from "./comment-anchor";
import type { DraftStorage } from "./drafts";

export const PRESENCE_VERSION = 1;
/** The room name the server allows in a Comb presence namespace. */
export const PRESENCE_ROOM = "default";

/** A pointer that has not moved for this long hides. */
export const POINTER_IDLE_MS = 3_000;
/** A selection hides when its peer sent nothing for this long (a live tab repeats it). */
export const SELECTION_TTL_MS = 15_000;
/** A peer that sent nothing for this long is gone. */
export const PEER_TTL_MS = 60_000;
/** A live tab publishes at least this often, so its selection and avatar stay. */
export const HEARTBEAT_MS = 10_000;

/** Longest selection quote sent. Longer selections send their first part. */
export const SELECTION_EXACT_MAX = 1_000;
const NAME_MAX = 80;
const ID_MAX = 128;
const PATH_MAX = 1_024;
const AVATAR_MAX = 512;
const LINE_MAX = 10_000_000;

export interface PresenceWho {
  /** The agent-fs user id. One person, several tabs: one peer. */
  id: string;
  name: string;
  /** An https image URL. agent-fs has no avatars today, so Comb shows initials. */
  avatar?: string;
}

export interface PresenceFile {
  path: string;
  version: number;
}

/** A selection as a comment anchor: the quote with context and its source lines. */
export interface PresenceSelection {
  exact: string;
  prefix?: string;
  suffix?: string;
  lineStart?: number;
  lineEnd?: number;
}

/**
 * A pointer over text: `line` is a position on the source-line axis (the
 * integer part is the line, the rest is how far down the block the pointer
 * is), `frac` is how far across the block (0 to 1).
 */
export interface LinePointer {
  line: number;
  frac: number;
}

/** A pointer over an image or a PDF, normalized to the media box (0 to 1). */
export interface MediaPointer {
  x: number;
  y: number;
}

export type PresencePointer = LinePointer | MediaPointer;

export interface PresenceData {
  v: typeof PRESENCE_VERSION;
  who: PresenceWho;
  /** Null: on the drive, not on a file (a folder, or the tab is hidden). */
  file: PresenceFile | null;
  sel: PresenceSelection | null;
  ptr: PresencePointer | null;
  /** The sender's clock at publish. Only compared with the same sender's older values. */
  t: number;
}

/** One connection's presence: the server's connection id plus the client's data. */
export interface ParsedPeer {
  connection: string;
  data: PresenceData;
}

/** localStorage key (per swarm, see `deriveStorageKey`) of the "Show cursors" choice. */
export const SHOW_CURSORS_KEY = "comb:show-cursors";

/** Whether to show other people's pointers and selections (and send ours). On by default. */
export function readShowCursors(storage: DraftStorage | null, apiUrl: string): boolean {
  try {
    return storage?.getItem(deriveStorageKey(apiUrl, SHOW_CURSORS_KEY)) !== "false";
  } catch {
    return true;
  }
}

export function writeShowCursors(storage: DraftStorage | null, apiUrl: string, show: boolean) {
  try {
    storage?.setItem(deriveStorageKey(apiUrl, SHOW_CURSORS_KEY), String(show));
  } catch {
    // A full or blocked localStorage only forgets the choice.
  }
}

/** The server refuses presence over 8 KiB. Comb stays well under it. */
export const PRESENCE_MAX_BYTES = 7_000;

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** `data` as sent: without the selection (then without the file) when it is too large. */
export function fitPresence(data: PresenceData): PresenceData {
  if (byteSize(data) <= PRESENCE_MAX_BYTES) return data;
  const noSelection = { ...data, sel: null };
  if (byteSize(noSelection) <= PRESENCE_MAX_BYTES) return noSelection;
  return { ...noSelection, file: null, ptr: null };
}

/** The namespace of a drive's presence room, or null when the ids do not fit the server rule. */
export function presenceNamespace(orgId: string, driveId: string): string | null {
  const id = /^[A-Za-z0-9_-]{1,64}$/;
  return id.test(orgId) && id.test(driveId) ? `presence:comb:${orgId}:${driveId}` : null;
}

// --- Validation ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Control and format characters (bidi overrides included) never reach a label.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

function cleanLabel(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function lineNumber(value: unknown): number | undefined {
  return finite(value) && value >= 1 ? Math.min(Math.floor(value), LINE_MAX) : undefined;
}

function parseWho(value: unknown): PresenceWho | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id || id.length > ID_MAX) return null;
  const who: PresenceWho = { id, name: cleanLabel(value.name, NAME_MAX) || id.slice(0, 8) };
  if (
    typeof value.avatar === "string" &&
    value.avatar.length <= AVATAR_MAX &&
    value.avatar.startsWith("https://")
  ) {
    who.avatar = value.avatar;
  }
  return who;
}

function parseFile(value: unknown): PresenceFile | null {
  if (!isRecord(value)) return null;
  const { path, version } = value;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > PATH_MAX) return null;
  if (!finite(version) || version < 1) return null;
  return { path, version: Math.floor(version) };
}

function parseSelection(value: unknown): PresenceSelection | null {
  if (!isRecord(value) || typeof value.exact !== "string") return null;
  const exact = value.exact.slice(0, SELECTION_EXACT_MAX);
  if (!exact.trim()) return null;
  const sel: PresenceSelection = { exact };
  if (typeof value.prefix === "string" && value.prefix) {
    sel.prefix = value.prefix.slice(-QUOTE_CONTEXT_CHARS);
  }
  if (typeof value.suffix === "string" && value.suffix) {
    sel.suffix = value.suffix.slice(0, QUOTE_CONTEXT_CHARS);
  }
  const lineStart = lineNumber(value.lineStart);
  if (lineStart !== undefined) {
    sel.lineStart = lineStart;
    sel.lineEnd = Math.max(lineStart, lineNumber(value.lineEnd) ?? lineStart);
  }
  return sel;
}

function parsePointer(value: unknown): PresencePointer | null {
  if (!isRecord(value)) return null;
  if (finite(value.line) && finite(value.frac)) {
    if (value.line < 1) return null;
    return { line: Math.min(value.line, LINE_MAX), frac: clamp(value.frac, 0, 1) };
  }
  if (finite(value.x) && finite(value.y)) {
    return { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) };
  }
  return null;
}

/**
 * One entry of the server's `peers` array (`{userId, name, kind, data}`), or
 * null when it is not a Comb peer: an agent, another version of the payload,
 * or data that does not validate. Strings are capped and numbers clamped, so
 * a peer can never paint outside its box or grow the page.
 */
export function parsePeer(raw: unknown): ParsedPeer | null {
  if (!isRecord(raw) || !isRecord(raw.data)) return null;
  if (raw.kind === "agent") return null;
  const connection = typeof raw.userId === "string" ? raw.userId : "";
  if (!connection || connection.length > 200) return null;
  const data = raw.data;
  if (data.v !== PRESENCE_VERSION || !finite(data.t)) return null;
  const who = parseWho(data.who);
  if (!who) return null;
  const file = parseFile(data.file);
  return {
    connection,
    data: {
      v: PRESENCE_VERSION,
      who,
      file,
      // A selection or a pointer means nothing without its file.
      sel: file ? parseSelection(data.sel) : null,
      ptr: file ? parsePointer(data.ptr) : null,
      t: data.t,
    },
  };
}

// --- Change tracking and expiry ------------------------------------------------

/** One connection's latest data plus the local times it last changed. */
export interface PeerState extends ParsedPeer {
  /** Local time of the last new data (any field, or a heartbeat). */
  seenAt: number;
  /** Local time the selection last changed. */
  selAt: number;
  /** Local time the pointer last changed. */
  ptrAt: number;
}

export function sameSelection(a: PresenceSelection | null, b: PresenceSelection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.exact === b.exact &&
    a.prefix === b.prefix &&
    a.suffix === b.suffix &&
    a.lineStart === b.lineStart &&
    a.lineEnd === b.lineEnd
  );
}

export function samePointer(a: PresencePointer | null, b: PresencePointer | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if ("line" in a && "line" in b) return a.line === b.line && a.frac === b.frac;
  if ("x" in a && "x" in b) return a.x === b.x && a.y === b.y;
  return false;
}

function sameFile(a: PresenceFile | null, b: PresenceFile | null): boolean {
  return a === b || (!!a && !!b && a.path === b.path && a.version === b.version);
}

/**
 * The next peer map from a `peers` frame. The server sends every peer's
 * latest data on each change of any peer, so a peer's times move only when
 * its own data changed. Connections missing from the frame are gone.
 */
export function mergePeers(
  previous: ReadonlyMap<string, PeerState>,
  incoming: readonly ParsedPeer[],
  now: number,
): Map<string, PeerState> {
  const next = new Map<string, PeerState>();
  for (const peer of incoming) {
    const before = previous.get(peer.connection);
    const { data } = peer;
    if (!before) {
      next.set(peer.connection, { ...peer, seenAt: now, selAt: now, ptrAt: now });
      continue;
    }
    const selSame = sameSelection(before.data.sel, data.sel);
    const ptrSame = samePointer(before.data.ptr, data.ptr);
    const unchanged =
      before.data.t === data.t &&
      selSame &&
      ptrSame &&
      sameFile(before.data.file, data.file) &&
      before.data.who.id === data.who.id &&
      before.data.who.name === data.who.name;
    next.set(
      peer.connection,
      unchanged
        ? before
        : {
            ...peer,
            seenAt: now,
            selAt: selSame ? before.selAt : now,
            ptrAt: ptrSame ? before.ptrAt : now,
          },
    );
  }
  return next;
}

/** A person to show: one per agent-fs user, their freshest tab. */
export interface PresencePeer {
  id: string;
  name: string;
  avatar?: string;
  /** Palette slot, 1 to `PEER_COLOR_COUNT`. */
  color: number;
  file: PresenceFile | null;
  sel: PresenceSelection | null;
  ptr: PresencePointer | null;
}

/**
 * The people to show at `now`: stale peers dropped, idle pointers and old
 * selections cleared, `exclude` (me in every tab, the swarm service account)
 * left out, and one entry per person. A person's tab on a file wins over a
 * tab on no file, then the freshest. `label` names a person (a drive member's
 * own name beats the name the peer sent). Sorted by name, so the avatar order
 * holds still.
 */
export function visiblePeers(
  states: Iterable<PeerState>,
  now: number,
  exclude: ReadonlySet<string>,
  label: (id: string, name: string) => string = (_id, name) => name,
): PresencePeer[] {
  const best = new Map<string, PeerState>();
  for (const state of states) {
    if (now - state.seenAt > PEER_TTL_MS) continue;
    if (exclude.has(state.data.who.id)) continue;
    const current = best.get(state.data.who.id);
    if (!current || rank(state) > rank(current)) best.set(state.data.who.id, state);
  }
  return [...best.values()]
    .map((state): PresencePeer => {
      const { who, file, sel, ptr } = state.data;
      return {
        id: who.id,
        name: label(who.id, who.name),
        ...(who.avatar ? { avatar: who.avatar } : {}),
        color: peerColor(who.id),
        file,
        sel: sel && now - state.seenAt <= SELECTION_TTL_MS ? sel : null,
        ptr: ptr && now - state.ptrAt <= POINTER_IDLE_MS ? ptr : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function rank(state: PeerState): number {
  // A file outranks any time difference.
  return (state.data.file ? 1e15 : 0) + state.seenAt;
}

/** When the peer list next changes on its own (an expiry), or null when nothing expires. */
export function nextExpiry(states: Iterable<PeerState>, now: number): number | null {
  let next: number | null = null;
  const consider = (at: number) => {
    if (at > now && (next === null || at < next)) next = at;
  };
  for (const state of states) {
    consider(state.seenAt + PEER_TTL_MS + 1);
    if (state.data.sel) consider(state.seenAt + SELECTION_TTL_MS + 1);
    if (state.data.ptr) consider(state.ptrAt + POINTER_IDLE_MS + 1);
  }
  return next;
}

// --- Colors -------------------------------------------------------------------

/** Palette slots: `--color-peer-1` to `--color-peer-8` in `styles/globals.css`. */
export const PEER_COLOR_COUNT = 8;

/** A stable palette slot (1 to 8) for a person, from their id (FNV-1a). */
export function peerColor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % PEER_COLOR_COUNT) + 1;
}

/** The CSS color of a palette slot. */
export function peerColorVar(color: number): string {
  return `var(--color-peer-${color})`;
}

/** The text color on a palette fill (one per theme). */
export const PEER_FOREGROUND_VAR = "var(--color-peer-foreground)";

/** The CSS highlight that paints a palette slot's selections (`::highlight(comb-peer-N)`). */
export function peerHighlightName(color: number): string {
  return `comb-peer-${color}`;
}

// --- Pointer math ----------------------------------------------------------------

/** A client-space box (a `DOMRect` fits). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * A pointer at client point (x, y) over a block that renders source lines
 * `lineStart` to `lineEnd` in `box`. Down the block maps onto the line span,
 * across the block onto `frac`. Rounded, so a sub-pixel move is no change.
 */
export function toLinePointer(
  box: Box,
  lineStart: number,
  lineEnd: number,
  x: number,
  y: number,
): LinePointer {
  const span = Math.max(1, lineEnd - lineStart + 1);
  const down = box.height > 0 ? clamp((y - box.top) / box.height, 0, 0.9999) : 0;
  const across = box.width > 0 ? clamp((x - box.left) / box.width, 0, 1) : 0;
  return { line: round4(lineStart + down * span), frac: round4(across) };
}

/** Where a line pointer lands in the block that renders `lineStart` to `lineEnd` in `box`. */
export function fromLinePointer(
  box: Box,
  lineStart: number,
  lineEnd: number,
  pointer: LinePointer,
): { x: number; y: number } {
  const span = Math.max(1, lineEnd - lineStart + 1);
  const down = clamp((pointer.line - lineStart) / span, 0, 1);
  return {
    x: box.left + clamp(pointer.frac, 0, 1) * box.width,
    y: box.top + down * box.height,
  };
}

/** A rendered block and the source lines it renders. */
export interface LineBlock {
  box: Box;
  lineStart: number;
  lineEnd: number;
}

/**
 * The lines between two blocks (an image, a margin): `above` ends before
 * them, `below` (null at the end) starts after them. Their pixel gap maps
 * onto the source lines between the blocks. With no line between them, the
 * pointer sits at the bottom of `above`.
 */
function gap(above: LineBlock, below: LineBlock | null) {
  const top = above.box.top + above.box.height;
  const first = above.lineEnd + 1;
  const span = below ? below.lineStart - first : 0;
  const left = Math.min(above.box.left, below?.box.left ?? above.box.left);
  const right = Math.max(
    above.box.left + above.box.width,
    below ? below.box.left + below.box.width : above.box.left + above.box.width,
  );
  return { top, height: below ? below.box.top - top : 0, first, span, left, width: right - left };
}

/** A pointer at client point (x, y) between two blocks (no block under it). */
export function toGapPointer(
  above: LineBlock,
  below: LineBlock | null,
  x: number,
  y: number,
): LinePointer {
  const g = gap(above, below);
  if (g.span <= 0 || g.height <= 0) {
    const { box } = above;
    return toLinePointer(box, above.lineStart, above.lineEnd, x, box.top + box.height);
  }
  const down = clamp((y - g.top) / g.height, 0, 0.9999);
  const across = g.width > 0 ? clamp((x - g.left) / g.width, 0, 1) : 0;
  return { line: round4(g.first + down * g.span), frac: round4(across) };
}

/** Where a line pointer between two blocks lands. */
export function fromGapPointer(
  above: LineBlock,
  below: LineBlock | null,
  pointer: LinePointer,
): { x: number; y: number } {
  const g = gap(above, below);
  const down = g.span > 0 ? clamp((pointer.line - g.first) / g.span, 0, 1) : 0;
  return {
    x: g.left + clamp(pointer.frac, 0, 1) * g.width,
    y: g.top + down * Math.max(0, g.height),
  };
}

/** A pointer at client point (x, y) over a media box, or null outside it. */
export function toMediaPointer(box: Box, x: number, y: number): MediaPointer | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const fx = (x - box.left) / box.width;
  const fy = (y - box.top) / box.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return { x: round4(fx), y: round4(fy) };
}

/** Where a media pointer lands in a media box. */
export function fromMediaPointer(box: Box, pointer: MediaPointer): { x: number; y: number } {
  return {
    x: box.left + clamp(pointer.x, 0, 1) * box.width,
    y: box.top + clamp(pointer.y, 0, 1) * box.height,
  };
}

/**
 * The quote to publish for the selection [start, end) of a text, with the
 * trimmed offsets it covers (for its source lines). Whitespace at the edges
 * is dropped, like a comment anchor. A long selection sends its first
 * `SELECTION_EXACT_MAX` characters with the context around that part, so the
 * receiver resolves exactly what it paints.
 */
export function selectionQuote(
  text: string,
  start: number,
  end: number,
): {
  quote: Pick<PresenceSelection, "exact" | "prefix" | "suffix">;
  start: number;
  end: number;
} | null {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (start >= end) return null;
  let stop = Math.min(end, start + SELECTION_EXACT_MAX);
  while (stop > start && /\s/.test(text[stop - 1])) stop--;
  const prefix = text.slice(Math.max(0, start - QUOTE_CONTEXT_CHARS), start);
  const suffix = text.slice(stop, stop + QUOTE_CONTEXT_CHARS);
  return {
    quote: {
      exact: text.slice(start, stop),
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {}),
    },
    start,
    end: stop,
  };
}
