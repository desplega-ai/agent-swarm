import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { subscribeTextSpace } = await import("./use-dom-text-space");
type Space = import("../../lib/comb/dom-text-space").DomTextSpace | null;

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

describe("subscribeTextSpace: one text space per pane", () => {
  test("two readers of one pane get the same space from one build", async () => {
    const root = mount('<p data-line-start="1" data-line-end="1">Hello</p>');
    const a: Space[] = [];
    const b: Space[] = [];
    const stopA = subscribeTextSpace(root, (space) => a.push(space));
    const stopB = subscribeTextSpace(root, (space) => b.push(space));
    await nextFrame();
    expect(a.at(-1)?.text.trim()).toBe("Hello");
    expect(b.at(-1)).toBe(a.at(-1) as Space);
    stopA();
    stopB();
  });

  test("a late reader gets the current space at once", async () => {
    const root = mount('<p data-line-start="1" data-line-end="1">Late</p>');
    const stopA = subscribeTextSpace(root, () => {});
    await nextFrame();
    let got: Space = null;
    const stopB = subscribeTextSpace(root, (space) => {
      got = space;
    });
    expect((got as Space)?.text.trim()).toBe("Late");
    stopA();
    stopB();
  });

  test("the last unsubscribe stops the observer, and a new reader builds again", async () => {
    const root = mount('<p data-line-start="1" data-line-end="1">One</p>');
    const seen: Space[] = [];
    const stop = subscribeTextSpace(root, (space) => seen.push(space));
    await nextFrame();
    stop();
    root.querySelector("p")?.append(" two");
    await nextFrame();
    await nextFrame();
    expect(seen.at(-1)?.text.trim()).toBe("One");
    let fresh: Space = null;
    const stopAgain = subscribeTextSpace(root, (space) => {
      fresh = space;
    });
    await nextFrame();
    expect((fresh as Space)?.text.trim()).toBe("One two");
    stopAgain();
  });
});
