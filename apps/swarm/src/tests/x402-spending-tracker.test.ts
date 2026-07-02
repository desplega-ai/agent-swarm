import { describe, expect, test } from "bun:test";
import { SpendingTracker } from "../x402/spending-tracker.ts";

describe("SpendingTracker", () => {
  describe("checkSpendingLimit", () => {
    test("returns null when payment is within limits", () => {
      const tracker = new SpendingTracker(5.0, 50.0);
      const result = tracker.checkSpendingLimit(3.0, "https://api.example.com");
      expect(result).toBeNull();
    });

    test("blocks payment exceeding per-request limit", () => {
      const tracker = new SpendingTracker(1.0, 50.0);
      const result = tracker.checkSpendingLimit(2.0, "https://api.example.com");

      expect(result).not.toBeNull();
      expect(result).toContain("exceeds per-request limit");
      expect(result).toContain("$2.00");
      expect(result).toContain("$1.00");
    });

    test("blocks payment that would exceed daily limit", () => {
      const tracker = new SpendingTracker(10.0, 5.0);
      // Record some existing spending
      tracker.recordPayment(4.0, "https://api.example.com/first");

      const result = tracker.checkSpendingLimit(2.0, "https://api.example.com/second");

      expect(result).not.toBeNull();
      expect(result).toContain("would exceed daily limit");
      expect(result).toContain("$5.00");
      expect(result).toContain("Already spent today: $4.00");
    });

    test("allows payment exactly at per-request limit", () => {
      const tracker = new SpendingTracker(1.0, 50.0);
      const result = tracker.checkSpendingLimit(1.0, "https://api.example.com");
      expect(result).toBeNull();
    });

    test("allows payment that exactly fills daily limit", () => {
      const tracker = new SpendingTracker(10.0, 10.0);
      tracker.recordPayment(5.0, "https://api.example.com/first");

      const result = tracker.checkSpendingLimit(5.0, "https://api.example.com/second");
      expect(result).toBeNull();
    });

    test("includes URL in error messages", () => {
      const tracker = new SpendingTracker(1.0, 50.0);
      const result = tracker.checkSpendingLimit(5.0, "https://paid-api.io/data");

      expect(result).toContain("https://paid-api.io/data");
    });
  });

  describe("recordPayment", () => {
    test("records a payment and updates today spending", () => {
      const tracker = new SpendingTracker(10.0, 100.0);
      expect(tracker.getTodaySpending()).toBe(0);

      tracker.recordPayment(3.5, "https://api.example.com");
      expect(tracker.getTodaySpending()).toBe(3.5);
    });

    test("accumulates multiple payments", () => {
      const tracker = new SpendingTracker(10.0, 100.0);

      tracker.recordPayment(1.0, "https://api.example.com/a");
      tracker.recordPayment(2.5, "https://api.example.com/b");
      tracker.recordPayment(0.75, "https://api.example.com/c");

      expect(tracker.getTodaySpending()).toBeCloseTo(4.25, 10);
    });
  });

  describe("getTodayRecords", () => {
    test("returns empty array when no payments recorded", () => {
      const tracker = new SpendingTracker(10.0, 100.0);
      expect(tracker.getTodayRecords()).toHaveLength(0);
    });

    test("returns records from today", () => {
      const tracker = new SpendingTracker(10.0, 100.0);
      tracker.recordPayment(1.0, "https://api.example.com/a");
      tracker.recordPayment(2.0, "https://api.example.com/b");

      const records = tracker.getTodayRecords();
      expect(records).toHaveLength(2);
      expect(records[0]!.amount).toBe(1.0);
      expect(records[0]!.url).toBe("https://api.example.com/a");
      expect(records[1]!.amount).toBe(2.0);
      expect(records[1]!.url).toBe("https://api.example.com/b");
    });

    test("records have timestamps", () => {
      const tracker = new SpendingTracker(10.0, 100.0);
      const before = Date.now();
      tracker.recordPayment(1.0, "https://api.example.com");
      const after = Date.now();

      const records = tracker.getTodayRecords();
      expect(records[0]!.timestamp).toBeGreaterThanOrEqual(before);
      expect(records[0]!.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe("getSummary", () => {
    test("returns correct initial summary", () => {
      const tracker = new SpendingTracker(2.0, 20.0);
      const summary = tracker.getSummary();

      expect(summary.todaySpent).toBe(0);
      expect(summary.todayCount).toBe(0);
      expect(summary.dailyLimit).toBe(20.0);
      expect(summary.maxPerRequest).toBe(2.0);
      expect(summary.dailyRemaining).toBe(20.0);
    });

    test("reflects spending after payments", () => {
      const tracker = new SpendingTracker(5.0, 15.0);
      tracker.recordPayment(3.0, "https://api.example.com/a");
      tracker.recordPayment(4.0, "https://api.example.com/b");

      const summary = tracker.getSummary();
      expect(summary.todaySpent).toBe(7.0);
      expect(summary.todayCount).toBe(2);
      expect(summary.dailyRemaining).toBe(8.0);
    });

    test("dailyRemaining does not go negative", () => {
      const tracker = new SpendingTracker(20.0, 5.0);
      // Force recording above limit (bypasses check)
      tracker.recordPayment(8.0, "https://api.example.com");

      const summary = tracker.getSummary();
      expect(summary.dailyRemaining).toBe(0);
    });
  });

  describe("pruneOldRecords", () => {
    test("removes records older than 48 hours on next recordPayment", () => {
      const tracker = new SpendingTracker(100.0, 1000.0);

      // Manually access the internal records to inject an old record
      // @ts-expect-error accessing private field for testing
      tracker.records.push({
        timestamp: Date.now() - 49 * 60 * 60 * 1000, // 49 hours ago
        amount: 50.0,
        url: "https://old.example.com",
      });

      // Verify the old record is there
      // @ts-expect-error accessing private field for testing
      expect(tracker.records).toHaveLength(1);

      // Recording a new payment triggers pruning
      tracker.recordPayment(1.0, "https://new.example.com");

      // Old record should be pruned, only new one remains
      // @ts-expect-error accessing private field for testing
      expect(tracker.records).toHaveLength(1);
      // @ts-expect-error accessing private field for testing
      expect(tracker.records[0].url).toBe("https://new.example.com");
    });

    test("keeps records within 48 hours", () => {
      const tracker = new SpendingTracker(100.0, 1000.0);

      // Inject a record from 47 hours ago (should survive)
      // @ts-expect-error accessing private field for testing
      tracker.records.push({
        timestamp: Date.now() - 47 * 60 * 60 * 1000,
        amount: 5.0,
        url: "https://recent.example.com",
      });

      tracker.recordPayment(1.0, "https://new.example.com");

      // Both records should remain
      // @ts-expect-error accessing private field for testing
      expect(tracker.records).toHaveLength(2);
    });
  });
});
