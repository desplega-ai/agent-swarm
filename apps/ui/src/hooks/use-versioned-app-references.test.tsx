import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { AppDetail } from "@/api/types";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => GlobalRegistrator.unregister());
const { createRoot } = await import("react-dom/client");
const { useVersionedAppReferences } = await import("./use-versioned-app-references");

const app = (id: string, revision: string) =>
  ({ id, definition: { revision } }) as unknown as AppDetail;

function Probe({ apps, auto }: { apps: Map<string, AppDetail>; auto: boolean }) {
  const state = useVersionedAppReferences(apps, [...apps.keys()], auto);
  return (
    <div>
      <span>
        {[...state.value]
          .map(([id, value]) => `${id}:${JSON.stringify(value.definition)}`)
          .join(",")}
      </span>
      <span data-pending>{String(state.pending)}</span>
      <button type="button" onClick={state.apply}>
        Apply
      </button>
    </div>
  );
}

test("borrowed definitions load new references and hold changed definitions", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (apps: Map<string, AppDetail>, auto = false) =>
    act(async () => root.render(<Probe apps={apps} auto={auto} />));
  await render(new Map());
  await render(new Map([["a", app("a", "one")]]));
  expect(container.textContent).toContain('a:{"revision":"one"}');
  await render(
    new Map([
      ["a", app("a", "two")],
      ["b", app("b", "one")],
    ]),
  );
  expect(container.textContent).toContain('a:{"revision":"one"}');
  expect(container.textContent).toContain('b:{"revision":"one"}');
  expect(container.querySelector("[data-pending]")?.textContent).toBe("true");
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).toContain('a:{"revision":"two"}');
  await render(new Map([["a", app("a", "three")]]), true);
  expect(container.textContent).toContain('a:{"revision":"three"}');
  expect(container.textContent).not.toContain('b:{"revision":"one"}');
  await act(async () => root.unmount());
  container.remove();
});
