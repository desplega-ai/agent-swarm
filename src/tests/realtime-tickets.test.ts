import { afterEach, describe, expect, test } from "bun:test";
import {
  issueRealtimeTicket,
  REALTIME_TICKET_CAPACITY,
  REALTIME_TICKET_TTL_MS,
  redeemRealtimeTicket,
  sweepRealtimeTickets,
} from "../realtime/tickets";

const auth = { kind: "operator", fingerprint: "test-operator" } as const;

afterEach(() => {
  sweepRealtimeTickets(Number.MAX_SAFE_INTEGER);
});

describe("realtime tickets", () => {
  test("issues URL-safe tickets with at least 128 bits and redeems once", () => {
    const issued = issueRealtimeTicket(auth, 1_000);

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(issued.ticket, "base64url")).toHaveLength(24);
    expect(issued.expiresAt).toBe(1_000 + REALTIME_TICKET_TTL_MS);
    expect(redeemRealtimeTicket(issued.ticket, 1_001)).toEqual(auth);
    expect(redeemRealtimeTicket(issued.ticket, 1_002)).toBeNull();
  });

  test("rejects expired tickets and sweeps expired entries", () => {
    const expired = issueRealtimeTicket(auth, 2_000);
    const swept = issueRealtimeTicket(auth, 3_000);

    expect(redeemRealtimeTicket(expired.ticket, expired.expiresAt)).toBeNull();
    expect(sweepRealtimeTickets(swept.expiresAt)).toBe(1);
    expect(redeemRealtimeTicket(swept.ticket, swept.expiresAt)).toBeNull();
  });

  test("evicts the oldest ticket when the size cap is reached", () => {
    const oldest = issueRealtimeTicket(auth, 4_000);
    let newest = oldest;
    for (let index = 0; index < REALTIME_TICKET_CAPACITY; index++) {
      newest = issueRealtimeTicket(auth, 4_000);
    }

    expect(redeemRealtimeTicket(oldest.ticket, 4_001)).toBeNull();
    expect(redeemRealtimeTicket(newest.ticket, 4_001)).toEqual(auth);
  });
});
