import { describe, expect, test } from "bun:test";
import { type ListKeyEvent, listKeyOf } from "./use-list-keys";

const list = { closest: () => null };

function keyEvent(key: string, extra: Partial<ListKeyEvent> = {}): ListKeyEvent {
  return {
    key,
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    target: list,
    currentTarget: list,
    ...extra,
  };
}

/** A focused child of the list that matches `selector` and nothing else. */
const childMatching = (selector: string) => ({
  closest: (asked: string) => (asked.includes(selector) ? {} : null),
});

describe("listKeyOf", () => {
  test("maps the list keys, letters in either case", () => {
    const map: Record<string, string> = {
      j: "next",
      ArrowDown: "next",
      k: "prev",
      ArrowUp: "prev",
      Home: "first",
      End: "last",
      Enter: "open",
      o: "open",
      ArrowRight: "expand",
      ArrowLeft: "collapse",
      x: "select",
      E: "done",
      l: "later",
      u: "read",
      M: "move",
      t: "newTab",
      V: "split",
      n: "nextUnread",
      c: "newSession",
      ContextMenu: "menu",
      Escape: "clear",
    };
    for (const [key, action] of Object.entries(map)) {
      expect({ key, action: listKeyOf(keyEvent(key)) }).toEqual({ key, action });
    }
  });

  test("leaves modifier combos to the browser, except Shift+F10 for the menu", () => {
    expect(listKeyOf(keyEvent("k", { metaKey: true }))).toBeNull();
    expect(listKeyOf(keyEvent("e", { ctrlKey: true }))).toBeNull();
    expect(listKeyOf(keyEvent("j", { altKey: true }))).toBeNull();
    expect(listKeyOf(keyEvent("E", { shiftKey: true }))).toBeNull();
    expect(listKeyOf(keyEvent("F10", { shiftKey: true }))).toBe("menu");
  });

  test("a held key moves the cursor but acts only once", () => {
    expect(listKeyOf(keyEvent("j", { repeat: true }))).toBe("next");
    expect(listKeyOf(keyEvent("ArrowUp", { repeat: true }))).toBe("prev");
    expect(listKeyOf(keyEvent("e", { repeat: true }))).toBeNull();
    expect(listKeyOf(keyEvent("x", { repeat: true }))).toBeNull();
  });

  test("a key an overlay or a composition already took never reaches the list", () => {
    expect(listKeyOf(keyEvent("Escape", { defaultPrevented: true }))).toBeNull();
    expect(listKeyOf(keyEvent("j", { nativeEvent: { isComposing: true } }))).toBeNull();
  });

  test("typing targets keep their keys, and Enter stays with a focused control", () => {
    expect(listKeyOf(keyEvent("j", { target: childMatching("input") }))).toBeNull();
    expect(listKeyOf(keyEvent("Enter", { target: childMatching("button") }))).toBeNull();
    expect(listKeyOf(keyEvent("e", { target: childMatching("button") }))).toBe("done");
  });
});
