import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

// A DOM for the render tests; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom and sonner read the DOM when they first load: import them after it exists.
const { createRoot } = await import("react-dom/client");
const { Toaster, toast } = await import("sonner");
const { notePromptSent } = await import("./github-star-nudge-toast");

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const toasts = () => [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")];
const starToast = () =>
  toasts().find((el) => el.textContent?.includes("Enjoying agent-swarm?")) ?? null;
const doneKeys = () =>
  Object.keys(localStorage).filter((key) => key.endsWith("github-star-nudge:done"));

let root: ReturnType<typeof createRoot>;

beforeAll(async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Toaster />));
});

afterAll(async () => {
  await act(async () => root.unmount());
  await GlobalRegistrator.unregister();
});

describe("github star nudge toast", () => {
  test("hides its contents while a newer toast collapses it, and the X ends it", async () => {
    localStorage.clear();
    for (let i = 0; i < 5; i++) notePromptSent();
    await tick();
    await act(
      async () =>
        void toast.error("Attachment upload failed", { duration: Number.POSITIVE_INFINITY }),
    );
    await tick();

    const star = starToast();
    expect(star).not.toBeNull();
    // Sonner hides collapsed contents only for styled toasts; this custom one
    // must carry its own hide rule, keyed on the attributes sonner sets.
    expect(star?.dataset.styled).toBe("false");
    expect(star?.matches("[data-expanded=false][data-front=false]")).toBe(true);
    expect(star?.className.split(" ")).toContain(
      "[&[data-expanded=false][data-front=false]>*]:opacity-0",
    );
    expect(star?.className.split(" ")).toContain(
      "[&[data-expanded=false][data-front=false]>*]:pointer-events-none",
    );

    await act(async () =>
      star?.querySelector<HTMLButtonElement>("button[aria-label=Close]")?.click(),
    );
    await tick();
    expect(doneKeys()).toHaveLength(1);
    await act(async () => toast.dismiss());
  });

  test("the star button opens the repo and ends the nudge", async () => {
    localStorage.clear();
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const opened: unknown[][] = [];
    const realOpen = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      for (let i = 0; i < 5; i++) notePromptSent();
      await tick();
      await act(async () =>
        starToast()?.querySelector<HTMLButtonElement>("[data-slot=button]")?.click(),
      );
      await tick();
      expect(opened).toEqual([
        ["https://github.com/desplega-ai/agent-swarm", "_blank", "noopener,noreferrer"],
      ]);
      expect(doneKeys()).toHaveLength(1);
    } finally {
      window.open = realOpen;
    }
  });
});
