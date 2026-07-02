import { describe, expect, it } from "bun:test";
import { normalizeDate, normalizeDateRequired } from "../be/date-utils";

describe("normalizeDate", () => {
  it("returns null for null input", () => {
    expect(normalizeDate(null)).toBe(null);
  });

  it("returns null for undefined input", () => {
    expect(normalizeDate(undefined)).toBe(null);
  });

  it("converts bare datetime format to ISO 8601", () => {
    expect(normalizeDate("2026-03-31 14:30:00")).toBe("2026-03-31T14:30:00.000Z");
  });

  it("converts midnight bare datetime", () => {
    expect(normalizeDate("2026-01-01 00:00:00")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("passes through ISO 8601 with Z suffix unchanged", () => {
    expect(normalizeDate("2026-03-31T14:30:00.000Z")).toBe("2026-03-31T14:30:00.000Z");
  });

  it("passes through ISO 8601 with milliseconds and Z", () => {
    expect(normalizeDate("2026-03-31T14:30:00.123Z")).toBe("2026-03-31T14:30:00.123Z");
  });

  it("passes through toISOString() output unchanged", () => {
    const iso = new Date().toISOString();
    expect(normalizeDate(iso)).toBe(iso);
  });

  it("passes through strftime output unchanged", () => {
    // strftime('%Y-%m-%dT%H:%M:%fZ', 'now') produces this format
    expect(normalizeDate("2026-03-31T14:30:00.000Z")).toBe("2026-03-31T14:30:00.000Z");
  });
});

describe("normalizeDateRequired", () => {
  it("converts bare datetime format to ISO 8601", () => {
    expect(normalizeDateRequired("2026-03-31 14:30:00")).toBe("2026-03-31T14:30:00.000Z");
  });

  it("passes through ISO 8601 unchanged", () => {
    expect(normalizeDateRequired("2026-03-31T14:30:00.123Z")).toBe("2026-03-31T14:30:00.123Z");
  });
});
