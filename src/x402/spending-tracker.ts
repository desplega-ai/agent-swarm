/**
 * x402 Spending Tracker
 *
 * Tracks spending per request and per day to enforce limits.
 * Uses an in-memory store — resets on process restart.
 *
 * Concurrency: `reserve()` checks the limits and holds the amount in a single
 * synchronous step, so concurrent payments in the same process cannot all pass
 * the daily check against the same remaining budget. A reservation is then
 * either `confirm()`ed (counted as spent) or `release()`d (freed).
 */

export interface SpendingRecord {
  timestamp: number;
  amount: number;
  url: string;
}

export interface SpendingReservation {
  amount: number;
  url: string;
  timestamp: number;
}

export type ReserveResult = { ok: true; id: string } | { ok: false; reason: string };

export class SpendingTracker {
  private records: SpendingRecord[] = [];
  private reservations = new Map<string, SpendingReservation>();
  private nextReservationId = 0;
  private readonly maxPerRequest: number;
  private readonly dailyLimit: number;

  constructor(maxPerRequest: number, dailyLimit: number) {
    this.maxPerRequest = maxPerRequest;
    this.dailyLimit = dailyLimit;
  }

  /**
   * Check if a payment amount is within spending limits.
   * Returns an error message if the payment should be blocked, or null if allowed.
   */
  checkSpendingLimit(amountUsd: number, url: string): string | null {
    if (amountUsd > this.maxPerRequest) {
      return (
        `Payment of $${amountUsd.toFixed(2)} exceeds per-request limit of ` +
        `$${this.maxPerRequest.toFixed(2)} (X402_MAX_AUTO_APPROVE). URL: ${url}`
      );
    }

    const todaySpent = this.getTodaySpending();
    const reserved = this.getReservedAmount();
    if (todaySpent + reserved + amountUsd > this.dailyLimit) {
      const pending = reserved > 0 ? ` (plus $${reserved.toFixed(2)} reserved in flight)` : "";
      return (
        `Payment of $${amountUsd.toFixed(2)} would exceed daily limit of ` +
        `$${this.dailyLimit.toFixed(2)} (X402_DAILY_LIMIT). ` +
        `Already spent today: $${todaySpent.toFixed(2)}${pending}. URL: ${url}`
      );
    }

    return null;
  }

  /**
   * Check the limits and hold the amount in one synchronous step.
   * Returns a reservation id to `confirm()` or `release()` later, or the reason
   * the payment is blocked. Because there is no await between the check and the
   * hold, concurrent callers in this process cannot both pass against the same
   * remaining budget.
   */
  reserve(amountUsd: number, url: string): ReserveResult {
    const reason = this.checkSpendingLimit(amountUsd, url);
    if (reason) return { ok: false, reason };
    const id = String(++this.nextReservationId);
    this.reservations.set(id, { amount: amountUsd, url, timestamp: Date.now() });
    return { ok: true, id };
  }

  /**
   * Turn a reservation into a recorded payment. Unknown ids are ignored.
   */
  confirm(id: string): void {
    const reservation = this.reservations.get(id);
    if (!reservation) return;
    this.reservations.delete(id);
    this.recordPayment(reservation.amount, reservation.url);
  }

  /**
   * Free a reservation without recording a payment (e.g. payment creation failed).
   */
  release(id: string): void {
    this.reservations.delete(id);
  }

  /**
   * Total amount currently reserved but not yet confirmed or released.
   */
  getReservedAmount(): number {
    let total = 0;
    for (const r of this.reservations.values()) total += r.amount;
    return total;
  }

  /**
   * Record a payment that was made.
   */
  recordPayment(amountUsd: number, url: string): void {
    this.records.push({
      timestamp: Date.now(),
      amount: amountUsd,
      url,
    });
    this.pruneOldRecords();
  }

  /**
   * Get total spending for today (UTC).
   */
  getTodaySpending(): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startTs = startOfDay.getTime();

    return this.records.filter((r) => r.timestamp >= startTs).reduce((sum, r) => sum + r.amount, 0);
  }

  /**
   * Get all spending records for today.
   */
  getTodayRecords(): SpendingRecord[] {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startTs = startOfDay.getTime();
    return this.records.filter((r) => r.timestamp >= startTs);
  }

  /**
   * Get spending summary.
   */
  getSummary(): {
    todaySpent: number;
    todayCount: number;
    dailyLimit: number;
    maxPerRequest: number;
    dailyRemaining: number;
    reserved: number;
  } {
    const todaySpent = this.getTodaySpending();
    const todayRecords = this.getTodayRecords();
    const reserved = this.getReservedAmount();
    return {
      todaySpent,
      todayCount: todayRecords.length,
      dailyLimit: this.dailyLimit,
      maxPerRequest: this.maxPerRequest,
      dailyRemaining: Math.max(0, this.dailyLimit - todaySpent - reserved),
      reserved,
    };
  }

  /**
   * Remove records older than 48 hours to prevent unbounded growth.
   */
  private pruneOldRecords(): void {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    this.records = this.records.filter((r) => r.timestamp >= cutoff);
  }
}
