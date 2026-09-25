import { describe, expect, test } from "bun:test";
import { matchDetailShortcut, matchListShortcut } from "./approval-shortcuts";

/** A stand-in for an Element: `closest` matches when a selector part is in `matches`. */
function el(...matches: string[]) {
  return {
    closest: (selector: string) =>
      selector.split(", ").some((part) => matches.includes(part.trim())) || null,
  };
}

const input = el("input");
const textarea = el("textarea");
const button = el("button");
const page = el("section");

describe("matchDetailShortcut", () => {
  test("maps single keys when focus is on the page", () => {
    expect(matchDetailShortcut({ key: "j", target: page })).toEqual({ type: "next" });
    expect(matchDetailShortcut({ key: "ArrowUp", target: page })).toEqual({ type: "prev" });
    expect(matchDetailShortcut({ key: "a", target: page })).toEqual({ type: "approve" });
    expect(matchDetailShortcut({ key: "r", target: page })).toEqual({ type: "reject" });
    expect(matchDetailShortcut({ key: "3", target: page })).toEqual({ type: "pick", index: 2 });
    expect(matchDetailShortcut({ key: " ", target: page })).toEqual({ type: "toggle" });
    expect(matchDetailShortcut({ key: "?", target: page })).toEqual({ type: "help" });
    expect(matchDetailShortcut({ key: "Escape", target: page })).toEqual({ type: "back" });
    expect(matchDetailShortcut({ key: "0", target: page })).toBeNull();
  });

  test("never fires single-key shortcuts inside a text field", () => {
    for (const target of [
      input,
      textarea,
      el('[contenteditable]:not([contenteditable="false"])'),
    ]) {
      for (const key of ["j", "k", "a", "r", "1", " ", "?", "ArrowDown", "Enter", "o"]) {
        expect(matchDetailShortcut({ key, target })).toBeNull();
      }
    }
  });

  test("inside a text field, Esc only leaves the field (never navigates back)", () => {
    expect(matchDetailShortcut({ key: "Escape", target: input })).toEqual({ type: "leave-field" });
  });

  test("Cmd/Ctrl+Enter submits from anywhere, including text fields", () => {
    expect(matchDetailShortcut({ key: "Enter", metaKey: true, target: textarea })).toEqual({
      type: "submit",
    });
    expect(matchDetailShortcut({ key: "Enter", ctrlKey: true, target: page })).toEqual({
      type: "submit",
    });
    expect(matchDetailShortcut({ key: "Enter", target: textarea })).toBeNull();
  });

  test("leaves modified keys, IME composition, and open overlays alone", () => {
    expect(matchDetailShortcut({ key: "a", metaKey: true, target: page })).toBeNull();
    expect(matchDetailShortcut({ key: "a", altKey: true, target: page })).toBeNull();
    expect(matchDetailShortcut({ key: "a", isComposing: true, target: page })).toBeNull();
    expect(matchDetailShortcut({ key: "a", target: page }, { overlayOpen: true })).toBeNull();
    expect(matchDetailShortcut({ key: "a", defaultPrevented: true, target: page })).toBeNull();
  });

  test("a focused control keeps Space, Enter and arrows; letters still work", () => {
    expect(matchDetailShortcut({ key: " ", target: button })).toBeNull();
    expect(matchDetailShortcut({ key: "Enter", target: button })).toBeNull();
    expect(matchDetailShortcut({ key: "ArrowDown", target: el('[role="radio"]') })).toBeNull();
    expect(matchDetailShortcut({ key: "j", target: button })).toEqual({ type: "next" });
    expect(matchDetailShortcut({ key: "a", target: button })).toEqual({ type: "approve" });
  });

  test("a held key repeats movement only, never a decision or a submit", () => {
    for (const key of ["a", "r", "1", " ", "o", "?", "Escape", "Enter"]) {
      expect(matchDetailShortcut({ key, repeat: true, target: page })).toBeNull();
    }
    expect(
      matchDetailShortcut({ key: "Enter", metaKey: true, repeat: true, target: page }),
    ).toBeNull();
    expect(matchDetailShortcut({ key: "j", repeat: true, target: page })).toEqual({
      type: "next",
    });
    expect(matchDetailShortcut({ key: "ArrowUp", repeat: true, target: page })).toEqual({
      type: "prev",
    });
    expect(matchDetailShortcut({ key: "ArrowRight", repeat: true, target: page })).toEqual({
      type: "cursor",
      delta: 1,
    });
  });
});

describe("matchListShortcut", () => {
  test("j/k move and Enter opens", () => {
    expect(matchListShortcut({ key: "j", target: page })).toEqual({ type: "next" });
    expect(matchListShortcut({ key: "k", target: page })).toEqual({ type: "prev" });
    expect(matchListShortcut({ key: "Enter", target: page })).toEqual({ type: "open" });
  });

  test("typing in the search box never moves the list", () => {
    for (const key of ["j", "k", "Enter", "ArrowDown"]) {
      expect(matchListShortcut({ key, target: input })).toBeNull();
    }
  });

  test("a focused row link opens itself on Enter natively", () => {
    expect(matchListShortcut({ key: "Enter", target: el("a[href]") })).toBeNull();
  });

  test("a held Enter opens the row once; held j/k keep moving", () => {
    expect(matchListShortcut({ key: "Enter", repeat: true, target: page })).toBeNull();
    expect(matchListShortcut({ key: "j", repeat: true, target: page })).toEqual({ type: "next" });
  });
});
