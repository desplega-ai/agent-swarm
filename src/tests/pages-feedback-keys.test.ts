/**
 * Typing in the page feedback overlay must not reach the page's own key
 * handlers. The overlay lives in a shadow root, so outside it the event target
 * is the shadow host and a page's "ignore keys from a textarea" guard misses:
 * Space and arrows typed into a comment used to change slides in a deck page.
 * So the overlay keeps its keys to itself.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { feedbackOverlayScripts } from "../pages/feedback-overlay";

function overlayPage() {
  const window = new Window({ url: "https://api.example.test/p/abc" });
  const document = window.document;
  document.body.innerHTML = "<h2>Slide title</h2>";
  const pageKeys: string[] = [];
  // A page key handler (e.g. a deck's slide navigation). It records every key it
  // sees: a page cannot reliably tell overlay keys apart, because a real browser
  // retargets them to the shadow host.
  window.addEventListener("keydown", (e) => pageKeys.push((e as unknown as KeyboardEvent).key));
  for (const [, source] of feedbackOverlayScripts("abc").matchAll(
    /<script>([\s\S]*?)<\/script>/g,
  )) {
    window.eval(source!);
  }
  const root = document.querySelector("swarm-feedback-root")!.shadowRoot!;
  return { window, document, root, pageKeys };
}

function press(window: Window, target: { dispatchEvent(e: unknown): boolean }, key: string) {
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
}

describe("page feedback overlay keys", () => {
  test("keys typed in a comment box never reach the page", () => {
    const { window, document, root, pageKeys } = overlayPage();
    const select = [...root.querySelectorAll("button")].find(
      (b) => b.textContent === "Select an element",
    )!;
    select.click();
    document.querySelector("h2")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const comment = root.querySelector("textarea");
    expect(comment).not.toBeNull();

    for (const key of [" ", "ArrowRight", "ArrowLeft", "PageDown"]) press(window, comment!, key);
    expect(pageKeys).toEqual([]);
  });

  test("keys outside the overlay still reach the page", () => {
    const { window, document, pageKeys } = overlayPage();
    press(window, document.body, "ArrowRight");
    expect(pageKeys).toEqual(["ArrowRight"]);
  });
});
