import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// No `act()` here on purpose: the bug only shows when React runs as in a
// browser, with sync key updates and router updates in a transition.
GlobalRegistrator.register();
afterAll(async () => {
  // Let React's scheduler finish its last tasks while the DOM still exists.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, useLocation } = await import("react-router-dom");
const { readStringParam, useUrlSearchInput, useUrlSearchState } = await import(
  "./use-url-search-state"
);

const DELAY = 10;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry `check` until it stops throwing. A fixed sleep after a timer or a
 * router transition fails when a loaded CI runner delays the render, so the
 * tests wait for the outcome, not for a guessed duration.
 */
async function waitFor(check: () => void, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await sleep(5);
    }
  }
}

function Probe() {
  const [search, setSearch] = useUrlSearchInput("search", { delayMs: DELAY });
  const { setParam } = useUrlSearchState();
  const location = useLocation();
  return (
    <div>
      <input aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
      <span data-testid="url">{location.search}</span>
      <button type="button" onClick={() => setParam("search", null)}>
        Reset
      </button>
    </div>
  );
}

/** The input as it was before: bound straight to the URL. */
function UrlBound() {
  const { searchParams, setParam } = useUrlSearchState();
  return (
    <input
      aria-label="Search"
      value={readStringParam(searchParams, "search")}
      onChange={(e) => setParam("search", e.target.value)}
    />
  );
}

async function mount(node: React.ReactNode, initial = "/") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(<MemoryRouter initialEntries={[initial]}>{node}</MemoryRouter>);
  await waitFor(() => expect(container.querySelector("input")).not.toBeNull());
  const input = container.querySelector("input") as HTMLInputElement;
  const url = () => container.querySelector('[data-testid="url"]')?.textContent ?? "";
  /** Keys faster than renders: each one appends to what the input shows now. */
  const typeFast = (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    for (const ch of text) {
      setter?.call(input, input.value + ch);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  return { container, root, input, url, typeFast };
}

describe("useUrlSearchInput", () => {
  test("a URL-bound input drops fast keys (the bug this hook fixes)", async () => {
    const view = await mount(<UrlBound />);
    view.typeFast("telegram");
    await sleep(DELAY * 4);
    expect(view.input.value).not.toBe("telegram");
    view.root.unmount();
  });

  test("every key lands in the input, and the URL follows once typing pauses", async () => {
    const view = await mount(<Probe />);
    view.typeFast("telegram");
    expect(view.input.value).toBe("telegram");
    expect(view.url()).toBe("");
    await waitFor(() => expect(view.url()).toBe("?search=telegram"));
    expect(view.input.value).toBe("telegram");
    view.root.unmount();
  });

  test("starts from the URL, and a reset from elsewhere replaces the local value", async () => {
    const view = await mount(<Probe />, "/?search=slack");
    expect(view.input.value).toBe("slack");
    view.container.querySelector("button")?.click();
    await waitFor(() => {
      expect(view.url()).toBe("");
      expect(view.input.value).toBe("");
    });
    view.root.unmount();
  });
});
