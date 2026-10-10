import type { HttpRequestAuth } from "../utils/request-auth-context";

export const REALTIME_TICKET_TTL_MS = 60_000;
export const REALTIME_TICKET_CAPACITY = 10_000;

export type RealtimeTicketAuth = Extract<HttpRequestAuth, { kind: "operator" | "user" }>;

type StoredTicket = {
  auth: RealtimeTicketAuth;
  expiresAt: number;
};

const tickets = new Map<string, StoredTicket>();

export function sweepRealtimeTickets(now = Date.now()): number {
  let removed = 0;
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt > now) continue;
    tickets.delete(ticket);
    removed++;
  }
  return removed;
}

export function issueRealtimeTicket(
  auth: RealtimeTicketAuth,
  now = Date.now(),
): { ticket: string; expiresAt: number } {
  sweepRealtimeTickets(now);
  while (tickets.size >= REALTIME_TICKET_CAPACITY) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }

  let ticket: string;
  do {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    ticket = Buffer.from(bytes).toString("base64url");
  } while (tickets.has(ticket));

  const expiresAt = now + REALTIME_TICKET_TTL_MS;
  tickets.set(ticket, { auth, expiresAt });
  return { ticket, expiresAt };
}

export function redeemRealtimeTicket(ticket: string, now = Date.now()): RealtimeTicketAuth | null {
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  return entry.expiresAt > now ? entry.auth : null;
}
