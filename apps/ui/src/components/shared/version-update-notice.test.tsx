import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// React DOM and Sonner must detect the browser after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { Toaster, toast } = await import("sonner");
const { useVersionUpdateToast, versionUpdateNotice } = await import("./version-update-notice");

let toasterRoot: ReturnType<typeof createRoot> | undefined;
afterAll(async () => {
  // A mounted Toaster keeps scheduling React work (removal timers); unregistering
  // first lets that work fire with no `window`, an unhandled error that fails the run.
  await act(async () => toasterRoot?.unmount());
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  await GlobalRegistrator.unregister();
});

const base = {
  entityKey: "app:1",
  latestRevision: "v2",
  pending: true,
  editing: false,
  autoReload: false,
  canAutoReload: true,
};

describe("versionUpdateNotice", () => {
  test("offers a load while viewing", () => {
    const notice = versionUpdateNotice(base);
    expect(notice?.canLoad).toBe(true);
    expect(notice?.description).toBe("Load it when you are ready.");
  });

  test("asks to finish a draft first, under the same version key", () => {
    const viewing = versionUpdateNotice(base);
    const editing = versionUpdateNotice({ ...base, editing: true, canAutoReload: false });
    expect(editing?.canLoad).toBe(false);
    expect(editing?.description).toBe("Finish editing to load it.");
    expect(editing?.versionKey).toBe(viewing?.versionKey ?? "");
    expect(editing?.id).not.toBe(viewing?.id ?? "");
  });

  test("stays quiet when there is no update or auto reload applies it", () => {
    expect(versionUpdateNotice({ ...base, pending: false })).toBeNull();
    expect(versionUpdateNotice({ ...base, autoReload: true })).toBeNull();
  });

  test("explains a paused auto reload", () => {
    const notice = versionUpdateNotice({ ...base, autoReload: true, canAutoReload: false });
    expect(notice?.canLoad).toBe(true);
    expect(notice?.description).toContain("paused");
  });

  test("keys each revision separately", () => {
    const first = versionUpdateNotice(base);
    const second = versionUpdateNotice({ ...base, latestRevision: "v3" });
    expect(second?.versionKey).not.toBe(first?.versionKey ?? "");
  });
});

type ProbeProps = Partial<typeof base> & { onLoad?: () => void };
function Probe(props: ProbeProps) {
  useVersionUpdateToast({ ...base, onLoad: () => {}, ...props });
  return null;
}

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const toasts = () =>
  [...document.querySelectorAll<HTMLElement>("[data-testid=version-update-toast]")].filter(
    (el) => el.closest<HTMLElement>("[data-sonner-toast]")?.dataset.removed !== "true",
  );
const loadButton = () =>
  [...(toasts()[0]?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "Load latest",
  );

describe("useVersionUpdateToast", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const render = async (props: ProbeProps) => {
    await act(async () => root.render(<Probe {...props} />));
    await tick();
  };

  // The Toaster subscribes on mount, so it must exist before the first toast.
  beforeAll(async () => {
    const toasterHost = document.createElement("div");
    document.body.appendChild(toasterHost);
    toasterRoot = createRoot(toasterHost);
    await act(async () => toasterRoot?.render(<Toaster />));
  });

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    toast.dismiss();
    host.remove();
  });

  test("shows one toast and loads the version", async () => {
    let loads = 0;
    const onLoad = () => {
      loads += 1;
    };
    await render({ onLoad });
    await render({ onLoad });
    expect(toasts()).toHaveLength(1);
    await act(async () => loadButton()?.click());
    await tick();
    expect(loads).toBe(1);
    expect(toasts()).toHaveLength(0);
  });

  test("a dismissal holds until a newer version appears", async () => {
    await render({});
    await act(async () =>
      toasts()[0]?.querySelector<HTMLButtonElement>("button[aria-label=Close]")?.click(),
    );
    await tick();
    expect(toasts()).toHaveLength(0);
    await render({ editing: true, canAutoReload: false });
    expect(toasts()).toHaveLength(0);
    await render({ latestRevision: "v3" });
    expect(toasts()).toHaveLength(1);
  });

  test("a draft hides the load action until it clears", async () => {
    await render({ editing: true, canAutoReload: false });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.textContent).toContain("Finish editing to load it.");
    expect(loadButton()).toBeUndefined();
    await render({});
    expect(toasts()).toHaveLength(1);
    expect(loadButton()).toBeDefined();
  });

  test("closes when the viewer leaves the entity", async () => {
    await render({});
    expect(toasts()).toHaveLength(1);
    await render({ pending: false, entityKey: "app:2" });
    expect(toasts()).toHaveLength(0);
  });
});
