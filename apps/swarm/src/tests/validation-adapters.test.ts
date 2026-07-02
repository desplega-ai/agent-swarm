import { describe, expect, test } from "bun:test";
import { extractPassResult } from "../workflows/validation";

describe("extractPassResult — validation executor adapters", () => {
  // ─── validate executor ─────────────────────────────────────
  test("validate: { pass: true } → passes", () => {
    expect(extractPassResult("validate", { pass: true })).toBe(true);
  });

  test("validate: { pass: false } → fails", () => {
    expect(extractPassResult("validate", { pass: false })).toBe(false);
  });

  test("validate: { pass: false, reason: '...' } → fails", () => {
    expect(extractPassResult("validate", { pass: false, reason: "bad" })).toBe(false);
  });

  // ─── script executor ───────────────────────────────────────
  test("script: { exitCode: 0 } → passes", () => {
    expect(extractPassResult("script", { exitCode: 0 })).toBe(true);
  });

  test("script: { exitCode: 1 } → fails", () => {
    expect(extractPassResult("script", { exitCode: 1 })).toBe(false);
  });

  test("script: { exitCode: 127 } → fails", () => {
    expect(extractPassResult("script", { exitCode: 127 })).toBe(false);
  });

  // ─── property-match executor ───────────────────────────────
  test("property-match: { passed: true } → passes", () => {
    expect(extractPassResult("property-match", { passed: true })).toBe(true);
  });

  test("property-match: { passed: false } → fails", () => {
    expect(extractPassResult("property-match", { passed: false })).toBe(false);
  });

  // ─── raw-llm executor ─────────────────────────────────────
  test("raw-llm: { result: { pass: true } } → passes", () => {
    expect(extractPassResult("raw-llm", { result: { pass: true } })).toBe(true);
  });

  test("raw-llm: { result: { pass: false } } → fails", () => {
    expect(extractPassResult("raw-llm", { result: { pass: false } })).toBe(false);
  });

  test("raw-llm: { result: 'some string' } → fails (not object)", () => {
    expect(extractPassResult("raw-llm", { result: "some string" })).toBe(false);
  });

  // ─── unknown executor (generic fallback) ───────────────────
  test("unknown: { pass: true } → passes (generic fallback)", () => {
    expect(extractPassResult("custom-executor", { pass: true })).toBe(true);
  });

  test("unknown: { passed: true } → passes (generic fallback)", () => {
    expect(extractPassResult("custom-executor", { passed: true })).toBe(true);
  });

  test("unknown: { exitCode: 0 } → passes (generic fallback)", () => {
    expect(extractPassResult("custom-executor", { exitCode: 0 })).toBe(true);
  });

  test("unknown: { something: 'else' } → fails (no pass indicator)", () => {
    expect(extractPassResult("custom-executor", { something: "else" })).toBe(false);
  });

  // ─── edge cases ────────────────────────────────────────────
  test("null output → fails", () => {
    expect(extractPassResult("validate", null)).toBe(false);
  });

  test("undefined output → fails", () => {
    expect(extractPassResult("validate", undefined)).toBe(false);
  });

  test("string output → fails", () => {
    expect(extractPassResult("validate", "pass")).toBe(false);
  });

  test("number output → fails", () => {
    expect(extractPassResult("validate", 42)).toBe(false);
  });
});
