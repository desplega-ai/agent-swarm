/**
 * Typing in the page feedback overlay must not reach the page's own key
 * handlers. The overlay lives in a shadow root, so outside it the event target
 * is the shadow host and a page's "ignore keys from a textarea" guard misses:
 * Space and arrows typed into a comment used to change slides in a deck page.
 * Page capture listeners on window/document run before anything the overlay
 * registers later, so a key guard is served first in <head>.
 */
import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { feedbackKeyGuardScript, feedbackOverlayScripts } from "../pages/feedback-overlay";

type Target = { dispatchEvent(e: unknown): boolean };

function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

// Served order: key guard (top of <head>), page scripts, overlay (end of body).
function overlayPage() {
  const window = new Window({ url: "https://api.example.test/p/abc" });
  const document = window.document;
  document.body.innerHTML = "<h2>Slide title</h2>";
  for (const source of scriptSources(feedbackKeyGuardScript())) window.eval(source);
  // A page's key handlers (e.g. a deck's slide navigation), registered before
  // the overlay, in every phase. They record every key event they see.
  const pageKeys: string[] = [];
  for (const type of ["keydown", "keyup", "keypress"]) {
    const record = (where: string) => (e: Event) =>
      pageKeys.push(`${where}:${type}:${(e as unknown as KeyboardEvent).key}`);
    window.addEventListener(type, record("window-capture"), true);
    document.addEventListener(type, record("document-capture"), true);
    window.addEventListener(type, record("window-bubble"));
  }
  for (const source of scriptSources(feedbackOverlayScripts("abc"))) window.eval(source);
  const root = document.querySelector("swarm-feedback-root")!.shadowRoot!;
  return { window, document, root, pageKeys };
}

function key(window: Window, target: Target, type: string, key: string, init = {}) {
  target.dispatchEvent(
    new window.KeyboardEvent(type, { key, bubbles: true, composed: true, ...init }),
  );
}

function press(window: Window, target: Target, k: string) {
  key(window, target, "keydown", k);
  key(window, target, "keypress", k);
  key(window, target, "keyup", k);
}

function openComposer(window: Window, document: Window["document"], root: ShadowRoot) {
  // Select mode stays on after a comment, so the button is only there the first time.
  const select = [...root.querySelectorAll("button")].find(
    (b) => b.textContent === "Select an element",
  );
  select?.click();
  document.querySelector("h2")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const comment = root.querySelector("textarea") as unknown as HTMLTextAreaElement | null;
  expect(comment).not.toBeNull();
  return comment!;
}

function savedComments(window: Window): unknown[] {
  return JSON.parse(window.sessionStorage.getItem("swarm-feedback:abc") || "[]");
}

describe("page feedback overlay keys", () => {
  test("keys typed in a comment box never reach page capture or bubble handlers", () => {
    const { window, document, root, pageKeys } = overlayPage();
    const comment = openComposer(window, document, root);

    for (const k of [" ", "ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Enter", "PageDown"]) {
      press(window, comment, k);
    }
    expect(pageKeys).toEqual([]);
    // Escape still closes the composer, and the page never sees it.
    key(window, comment, "keydown", "Escape");
    expect(comment.isConnected).toBe(false);
    expect(pageKeys).toEqual([]);
  });

  test("the release of an overlay key stays in the overlay after the composer closes", () => {
    const { window, document, root, pageKeys } = overlayPage();

    // Escape: keydown closes the composer, keyup lands on the page body.
    let comment = openComposer(window, document, root);
    key(window, comment, "keydown", "Escape");
    expect(comment.isConnected).toBe(false);
    key(window, document.body, "keyup", "Escape");

    // Ctrl+Enter: keydown commits and removes the textarea, both keyups land on the body.
    comment = openComposer(window, document, root);
    comment.value = "Bigger title";
    key(window, comment, "keydown", "Control", { ctrlKey: true });
    key(window, comment, "keydown", "Enter", { ctrlKey: true });
    expect(comment.isConnected).toBe(false);
    expect(savedComments(window)).toHaveLength(1);
    key(window, document.body, "keyup", "Enter", { ctrlKey: true });
    key(window, document.body, "keyup", "Control");
    expect(pageKeys).toEqual([]);

    // The next press that starts on the page is the page's again.
    key(window, document.body, "keydown", "Escape");
    key(window, document.body, "keyup", "Escape");
    expect(pageKeys).toContain("window-bubble:keydown:Escape");
    expect(pageKeys).toContain("window-bubble:keyup:Escape");
  });

  test("keys outside the overlay still reach the page", () => {
    const { window, document, pageKeys } = overlayPage();
    press(window, document.body, "ArrowRight");
    expect(pageKeys).toEqual(
      ["keydown", "keypress", "keyup"].flatMap((type) => [
        `window-capture:${type}:ArrowRight`,
        `document-capture:${type}:ArrowRight`,
        `window-bubble:${type}:ArrowRight`,
      ]),
    );
  });
});
