import { describe, expect, test } from "bun:test";
import { isInboxAllowed, isSenderAllowed } from "../agentmail/handlers";

describe("isInboxAllowed", () => {
  test("allows all when filter is undefined", () => {
    expect(isInboxAllowed("bot@anything.dev", undefined)).toBe(true);
  });

  test("allows all when filter is empty string", () => {
    expect(isInboxAllowed("bot@anything.dev", "")).toBe(true);
  });

  test("allows matching single domain", () => {
    expect(isInboxAllowed("bot@x.dev", "x.dev")).toBe(true);
  });

  test("allows matching domain in comma-separated list", () => {
    expect(isInboxAllowed("bot@y.xyz", "x.dev,y.xyz")).toBe(true);
  });

  test("rejects non-matching domain", () => {
    expect(isInboxAllowed("bot@evil.com", "x.dev,y.xyz")).toBe(false);
  });

  test("handles whitespace in filter", () => {
    expect(isInboxAllowed("bot@y.xyz", "x.dev , y.xyz")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isInboxAllowed("bot@X.DEV", "x.dev")).toBe(true);
    expect(isInboxAllowed("bot@x.dev", "X.DEV")).toBe(true);
  });

  test("rejects inbox with no domain part", () => {
    expect(isInboxAllowed("nodomain", "x.dev")).toBe(false);
  });

  test("rejects empty inbox id", () => {
    expect(isInboxAllowed("", "x.dev")).toBe(false);
  });
});

describe("isSenderAllowed", () => {
  test("allows all when filter is undefined", () => {
    expect(isSenderAllowed("user@anything.com", undefined)).toBe(true);
  });

  test("allows all when filter is empty string", () => {
    expect(isSenderAllowed("user@anything.com", "")).toBe(true);
  });

  test("allows matching sender domain (string from_)", () => {
    expect(isSenderAllowed("alice@a.com", "a.com,b.com")).toBe(true);
  });

  test("allows matching sender domain (array from_)", () => {
    expect(isSenderAllowed(["alice@a.com"], "a.com,b.com")).toBe(true);
  });

  test("allows if any sender in array matches", () => {
    expect(isSenderAllowed(["alice@evil.com", "bob@b.com"], "a.com,b.com")).toBe(true);
  });

  test("rejects when no sender matches", () => {
    expect(isSenderAllowed("alice@evil.com", "a.com,b.com")).toBe(false);
  });

  test("rejects when no sender in array matches", () => {
    expect(isSenderAllowed(["alice@evil.com", "bob@evil.org"], "a.com,b.com")).toBe(false);
  });

  test("handles whitespace in filter", () => {
    expect(isSenderAllowed("alice@b.com", "a.com , b.com")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isSenderAllowed("alice@A.COM", "a.com")).toBe(true);
    expect(isSenderAllowed("alice@a.com", "A.COM")).toBe(true);
  });

  test("handles empty/null from_ gracefully", () => {
    expect(isSenderAllowed("", "a.com")).toBe(false);
    expect(isSenderAllowed([], "a.com")).toBe(false);
  });

  test("extracts domain from 'Name <email>' format (string)", () => {
    expect(isSenderAllowed("Taras Yarema <t@desplega.ai>", "desplega.ai,desplega.sh")).toBe(true);
  });

  test("extracts domain from 'Name <email>' format (array)", () => {
    expect(isSenderAllowed(["Taras <t@desplega.ai>"], "desplega.ai")).toBe(true);
  });

  test("rejects non-matching domain in 'Name <email>' format", () => {
    expect(isSenderAllowed("Taras <t@evil.com>", "desplega.ai")).toBe(false);
  });
});
