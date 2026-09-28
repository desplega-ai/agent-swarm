import { describe, expect, test } from "bun:test";
import { type EnterKeyDownEvent, shouldSubmitOnEnterKeyDown } from "./enter-submit";

function keyDown(overrides: Partial<EnterKeyDownEvent> = {}): EnterKeyDownEvent {
  return {
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    keyCode: 13,
    ...overrides,
  };
}

describe("shouldSubmitOnEnterKeyDown", () => {
  test("desktop: plain Enter submits", () => {
    expect(shouldSubmitOnEnterKeyDown(keyDown(), false)).toBe(true);
  });

  test("desktop: Shift+Enter inserts a newline, does not submit", () => {
    expect(shouldSubmitOnEnterKeyDown(keyDown({ shiftKey: true }), false)).toBe(false);
  });

  test("desktop: Cmd/Ctrl+Enter submits even with Shift held", () => {
    expect(shouldSubmitOnEnterKeyDown(keyDown({ metaKey: true, shiftKey: true }), false)).toBe(
      true,
    );
    expect(shouldSubmitOnEnterKeyDown(keyDown({ ctrlKey: true }), false)).toBe(true);
  });

  test("touch device: plain Enter inserts a newline, does not submit", () => {
    expect(shouldSubmitOnEnterKeyDown(keyDown(), true)).toBe(false);
  });

  test("touch device: Cmd/Ctrl+Enter still submits (hardware keyboard case)", () => {
    expect(shouldSubmitOnEnterKeyDown(keyDown({ ctrlKey: true }), true)).toBe(true);
  });

  test("IME composition never submits, on any device", () => {
    expect(shouldSubmitOnEnterKeyDown(keyDown({ isComposing: true }), false)).toBe(false);
    expect(shouldSubmitOnEnterKeyDown(keyDown({ isComposing: true }), true)).toBe(false);
    expect(shouldSubmitOnEnterKeyDown(keyDown({ keyCode: 229 }), false)).toBe(false);
  });

  test("non-Enter keys never submit", () => {
    expect(shouldSubmitOnEnterKeyDown(keyDown({ key: "a" }), false)).toBe(false);
  });
});
