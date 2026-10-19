// Session presence: who else has a session open, and who is typing. One
// realtime room per session (`presence:session:<rootTaskId>`, room
// "default"); each tab publishes one `SessionPresenceData` object and the
// server fans out every peer's latest object. The server lets only viewers
// with read access join, and drops a tab's presence when its socket closes.
//
// Peer data is client-asserted and untrusted: `parseSessionPeer` validates it.
//
// Relative imports only: `bun:test` runs this from the repo root.

import { type PresenceWho, parseWho, peerColor } from "./comb/presence";

export const SESSION_PRESENCE_VERSION = 1;
/** A live tab publishes at least this often. */
export const SESSION_HEARTBEAT_MS = 10_000;
/** Typing changes go out at most this often. */
export const TYPING_THROTTLE_MS = 2_000;

export interface SessionPresenceData {
  v: typeof SESSION_PRESENCE_VERSION;
  who: PresenceWho;
  /** The composer has focus and holds text. */
  typing: boolean;
  /** The sender's clock at publish. */
  t: number;
}

/** One connection's presence: the server's connection id plus the client's data. */
export interface ParsedSessionPeer {
  connection: string;
  data: SessionPresenceData;
}

/** One person in the session (all their tabs folded together). */
export interface SessionViewer {
  id: string;
  name: string;
  avatar?: string;
  /** Palette slot, see `peerColor`. */
  color: number;
  typing: boolean;
}

/** The namespace of a session's presence room, or null when the id does not fit the server rule. */
export function sessionPresenceNamespace(rootTaskId: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(rootTaskId) ? `presence:session:${rootTaskId}` : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One raw `peers` entry, validated. Agents and malformed entries are dropped. */
export function parseSessionPeer(raw: unknown): ParsedSessionPeer | null {
  if (!isRecord(raw) || !isRecord(raw.data)) return null;
  if (raw.kind === "agent") return null;
  const connection = typeof raw.userId === "string" ? raw.userId : "";
  if (!connection || connection.length > 200) return null;
  const data = raw.data;
  if (data.v !== SESSION_PRESENCE_VERSION) return null;
  if (typeof data.t !== "number" || !Number.isFinite(data.t)) return null;
  const who = parseWho(data.who);
  if (!who) return null;
  return {
    connection,
    data: { v: SESSION_PRESENCE_VERSION, who, typing: data.typing === true, t: data.t },
  };
}

/**
 * The people to show: everyone but `selfId`, one entry per person (a person
 * with two tabs is typing when either tab is), sorted by name.
 */
export function sessionViewers(
  peers: readonly ParsedSessionPeer[],
  selfId: string | null | undefined,
): SessionViewer[] {
  const byPerson = new Map<string, SessionViewer>();
  for (const { data } of peers) {
    if (data.who.id === selfId) continue;
    const existing = byPerson.get(data.who.id);
    if (existing) {
      existing.typing ||= data.typing;
      existing.avatar ??= data.who.avatar;
      continue;
    }
    byPerson.set(data.who.id, {
      id: data.who.id,
      name: data.who.name,
      ...(data.who.avatar ? { avatar: data.who.avatar } : {}),
      color: peerColor(data.who.id),
      typing: data.typing,
    });
  }
  return [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "Eze is typing…", "Eze and Mar are typing…", "3 people are typing…", or null. */
export function typingLabel(viewers: readonly SessionViewer[]): string | null {
  const typing = viewers.filter((v) => v.typing);
  if (typing.length === 0) return null;
  if (typing.length === 1) return `${typing[0].name} is typing…`;
  if (typing.length === 2) return `${typing[0].name} and ${typing[1].name} are typing…`;
  return `${typing.length} people are typing…`;
}
