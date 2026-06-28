/**
 * x402 Spending Tracker
 *
 * Tracks spending per request and per day to enforce limits.
 * Uses an in-memory store — resets on process restart.
 */

export interface SpendingRecord {
  timestamp: number;
  amount: number;
  url: string;
}

export class SpendingTracker {
  private records: SpendingRecord[] = [];
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
    if (todaySpent + amountUsd > this.dailyLimit) {
      return (
        `Payment of $${amountUsd.toFixed(2)} would exceed daily limit of ` +
        `$${this.dailyLimit.toFixed(2)} (X402_DAILY_LIMIT). ` +
        `Already spent today: $${todaySpent.toFixed(2)}. URL: ${url}`
      );
    }

    return null;
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
  } {
    const todaySpent = this.getTodaySpending();
    const todayRecords = this.getTodayRecords();
    return {
      todaySpent,
      todayCount: todayRecords.length,
      dailyLimit: this.dailyLimit,
      maxPerRequest: this.maxPerRequest,
      dailyRemaining: Math.max(0, this.dailyLimit - todaySpent),
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
