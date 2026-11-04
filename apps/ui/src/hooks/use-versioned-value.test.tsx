import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register({ settings: { enableIframePageLoading: true } });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => GlobalRegistrator.unregister());
const { createRoot } = await import("react-dom/client");
const { createPortal } = await import("react-dom");
const { useVersionedValue } = await import("./use-versioned-value");

function Probe({
  id,
  revision,
  auto,
  draft,
  onAutoApply,
}: {
  id: string;
  revision: string;
  auto: boolean;
  draft?: boolean;
  onAutoApply?: () => void;
}) {
  const state = useVersionedValue(id, revision, revision, auto, { draft, onAutoApply });
  return (
    <div
      ref={state.scopeRef}
      onInputCapture={state.markInteraction}
      onClickCapture={state.markInteraction}
    >
      <span data-testid="value">{state.value}</span>
      <span data-testid="pending">{String(state.pending)}</span>
      <span data-testid="editing">{String(state.editing)}</span>
      <input aria-label="Draft" />
      <iframe title="Preview" />
      {createPortal(<input aria-label="Portal draft" />, document.body)}
      <button type="button" onClick={state.apply}>
        Apply
      </button>
    </div>
  );
}

describe("versioned value", () => {
  test("holds changes until accepted and resets on navigation", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (id: string, revision: string, auto = false) =>
      act(async () => root.render(<Probe id={id} revision={revision} auto={auto} />));
    const value = () => container.querySelector('[data-testid="value"]')?.textContent;
    const pending = () => container.querySelector('[data-testid="pending"]')?.textContent;
    await render("one", "v1");
    await render("one", "v2");
    expect(value()).toBe("v1");
    expect(pending()).toBe("true");
    await act(async () => container.querySelector("button")?.click());
    expect(value()).toBe("v2");
    await render("two", "v3");
    expect(value()).toBe("v3");
    expect(pending()).toBe("false");
    await act(async () => root.unmount());
    container.remove();
  });

  test("automatic updates stop after interaction to protect drafts", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (revision: string) =>
      act(async () => root.render(<Probe id="one" revision={revision} auto />));
    await render("v1");
    await render("v2");
    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe("v2");
    await act(async () =>
      container.querySelector("input")?.dispatchEvent(new Event("input", { bubbles: true })),
    );
    await render("v3");
    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe("v2");
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("true");
    await act(async () => root.unmount());
    container.remove();
  });

  test("automatic updates wait after the viewer interacts with a frame", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (revision: string) =>
      act(async () => root.render(<Probe id="one" revision={revision} auto />));
    await render("v1");
    await act(async () =>
      container
        .querySelector("iframe")
        ?.dispatchEvent(new FocusEvent("focusin", { bubbles: true })),
    );
    await render("v2");
    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe("v1");
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("true");
    await act(async () => root.unmount());
    container.remove();
  });

  test("automatic updates wait for drafts in a portal", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (revision: string) =>
      act(async () => root.render(<Probe id="one" revision={revision} auto />));
    await render("v1");
    await act(async () =>
      document
        .querySelector('[aria-label="Portal draft"]')
        ?.dispatchEvent(new Event("input", { bubbles: true })),
    );
    await render("v2");
    expect(container.querySelector('[data-testid="value"]')?.textContent).toBe("v1");
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("true");
    await act(async () => root.unmount());
    container.remove();
  });

  test("automatic updates wait after an app control is used", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (revision: string) =>
      act(async () => root.render(<Probe id="one" revision={revision} auto />));
    await render("v1");
    const link = document.createElement("a");
    container.firstElementChild?.appendChild(link);
    await act(async () => link.click());
    await render("v2");
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("true");
    link.remove();
    await act(async () => root.unmount());
    container.remove();
  });

  test("reports automatic applies and holds them for drafts", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let applied = 0;
    const render = (revision: string, draft = false) =>
      act(async () =>
        root.render(
          <Probe
            id="one"
            revision={revision}
            auto
            draft={draft}
            onAutoApply={() => {
              applied += 1;
            }}
          />,
        ),
      );
    const text = (id: string) => container.querySelector(`[data-testid="${id}"]`)?.textContent;
    await render("v1");
    expect(applied).toBe(0);
    await render("v2");
    expect(text("value")).toBe("v2");
    expect(applied).toBe(1);
    await render("v3", true);
    expect(text("value")).toBe("v2");
    expect(text("editing")).toBe("true");
    expect(text("pending")).toBe("true");
    await render("v3", false);
    expect(text("value")).toBe("v3");
    expect(applied).toBe(2);
    await act(async () => root.unmount());
    container.remove();
  });

  test("a focused field counts as editing until focus leaves", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe id="one" revision="v1" auto={false} />));
    const editing = () => container.querySelector('[data-testid="editing"]')?.textContent;
    const input = container.querySelector<HTMLInputElement>('[aria-label="Draft"]');
    await act(async () => input?.focus());
    expect(editing()).toBe("true");
    await act(async () => input?.blur());
    expect(editing()).toBe("false");
    await act(async () => root.unmount());
    container.remove();
  });
});
