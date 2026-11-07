import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

// A DOM: the button renders and the hover card portals into the body.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const FILE = { orgId: "org-1", driveId: "drive-1", path: "/docs/plan.md" };

let loads: string[] = [];
let load: () => Promise<string> = () => Promise.resolve("# Plan");
const errors: string[] = [];
const successes: string[] = [];
let errorActions: { label: string; onClick: () => void }[] = [];

mock.module("@/api/hooks/use-agent-fs", () => ({
  useLoadTextToCopy: () => (target: { path: string }) => {
    loads.push(target.path);
    return load();
  },
}));
mock.module("@/components/comb/file-actions", () => ({
  DownloadButton: ({ label }: { label?: string }) => <button type="button">{label}</button>,
}));
mock.module("sonner", () => ({
  toast: {
    error: (message: string, options?: { action?: { label: string; onClick: () => void } }) => {
      errors.push(message);
      if (options?.action) errorActions.push(options.action);
    },
    success: (message: string) => successes.push(message),
  },
}));
// The real modules: a root `bun test` does not resolve the `@/` alias by itself.
for (const [alias, path] of [
  ["@/lib/utils", "../../lib/utils"],
  ["@/lib/format-bytes", "../../lib/format-bytes"],
  ["@/lib/comb/copy-contents", "../../lib/comb/copy-contents"],
  ["@/hooks/use-copy-to-clipboard", "../../hooks/use-copy-to-clipboard"],
  ["@/components/ui/button", "../ui/button"],
  ["@/components/ui/hover-card", "../ui/hover-card"],
  ["@/components/ui/spinner", "../ui/spinner"],
] as const) {
  mock.module(alias, () => require(path));
}

const { CopyFileButton, copyContentsFromMenu } = await import("./copy-file-button");
const { CANT_COPY_TYPE, CopyRejected, TOO_LARGE_TO_COPY } = await import(
  "../../lib/comb/copy-contents"
);

let clipboard: string[] = [];

/** `withItem`: the browser has `ClipboardItem` (Chrome, Safari); otherwise only `writeText`. */
function installClipboard(withItem: boolean) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async (items: { data: Record<string, Promise<Blob>> }[]) => {
        for (const item of items) {
          clipboard.push(`write:${await (await item.data["text/plain"])?.text()}`);
        }
      },
      writeText: async (text: string) => {
        clipboard.push(`writeText:${text}`);
      },
    },
  });
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = withItem
    ? class {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
      }
    : undefined;
}

async function mount(stat: { size: number; contentType?: string }, path = FILE.path) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const fullStat = {
    path,
    author: "a",
    createdAt: "2026-10-28T00:00:00Z",
    modifiedAt: "2026-10-28T00:00:00Z",
    isDeleted: false,
    currentVersion: 1,
    ...stat,
  };
  await act(async () => {
    root.render(<CopyFileButton file={{ ...FILE, path }} stat={fullStat} />);
  });
  const button = () => container.querySelector("button") as HTMLButtonElement;
  return {
    button,
    click: async () => {
      await act(async () => {
        button().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  loads = [];
  load = () => Promise.resolve("# Plan");
  clipboard = [];
  errors.length = 0;
  successes.length = 0;
  errorActions = [];
  installClipboard(true);
});

describe("CopyFileButton", () => {
  test("a click copies the contents through a ClipboardItem", async () => {
    const view = await mount({ size: 6, contentType: "text/markdown" });
    expect(view.button().getAttribute("aria-label")).toBe("Copy contents");
    await view.click();
    expect(loads).toEqual([FILE.path]);
    expect(clipboard).toEqual(["write:# Plan"]);
    expect(view.button().getAttribute("aria-label")).toBe("Contents copied");
  });

  test("a press on the button keeps the open card, which then says Contents copied", async () => {
    const view = await mount({ size: 6, contentType: "text/markdown" });
    // Keyboard focus opens the card, like hover.
    await act(async () => {
      view.button().focus();
      // Past the 300 ms open delay.
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(document.body.textContent).toContain("Click to copy the contents");
    await act(async () => {
      view.button().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await view.click();
    expect(clipboard).toEqual(["write:# Plan"]);
    expect(document.body.textContent).toContain("Contents copied");
    expect(document.body.textContent).toContain("Copy path");
  });

  test("without ClipboardItem it falls back to writeText", async () => {
    installClipboard(false);
    const view = await mount({ size: 6, contentType: "text/markdown" });
    await view.click();
    expect(clipboard).toEqual(["writeText:# Plan"]);
    expect(view.button().getAttribute("aria-label")).toBe("Contents copied");
  });

  test("a failed load copies nothing and toasts its reason", async () => {
    load = () => Promise.reject(new Error("agent-fs is not connected"));
    const view = await mount({ size: 6, contentType: "text/markdown" });
    await view.click();
    expect(clipboard).toEqual([]);
    expect(errors).toEqual(["agent-fs is not connected"]);
    expect(view.button().getAttribute("aria-label")).toBe("Copy contents");
  });

  test("bytes that turn out binary open the card with Download instead", async () => {
    // No extension and the generic type: the stat allows a copy, the bytes do not.
    load = () => Promise.reject(new CopyRejected(CANT_COPY_TYPE));
    const view = await mount({ size: 6, contentType: "application/octet-stream" }, "/README");
    expect(view.button().getAttribute("aria-label")).toBe("Copy contents");
    await view.click();
    expect(clipboard).toEqual([]);
    expect(errors).toEqual([]);
    expect(view.button().getAttribute("aria-label")).toBe(CANT_COPY_TYPE);
    const card = document.body.textContent ?? "";
    expect(card).toContain(CANT_COPY_TYPE);
    expect(card).not.toContain(`${CANT_COPY_TYPE} (`);
    expect(card).toContain("Download instead");
    // A second click shows the card again without another load.
    await view.click();
    expect(loads).toEqual(["/README"]);
  });

  test("an image does not copy: the click opens the card with Download instead", async () => {
    const view = await mount({ size: 4_000, contentType: "image/png" }, "/photo.png");
    expect(view.button().getAttribute("aria-label")).toBe("Can't copy this file type");
    await view.click();
    expect(loads).toEqual([]);
    expect(clipboard).toEqual([]);
    const card = document.body.textContent ?? "";
    expect(card).toContain("Can't copy this file type");
    expect(card).toContain("Download instead");
    expect(card).toContain("Copy path");
  });

  test("text above 1 MB does not copy and says it is too large", async () => {
    const view = await mount({ size: 3 * 1024 * 1024, contentType: "text/plain" }, "/big.log");
    expect(view.button().getAttribute("aria-label")).toBe("Too large to copy");
    await view.click();
    expect(loads).toEqual([]);
    expect(document.body.textContent).toContain("Too large to copy (3");
    expect(document.body.textContent).toContain("Download instead");
  });
});

describe("copyContentsFromMenu", () => {
  test("a copy toasts Contents copied", async () => {
    let downloads = 0;
    await copyContentsFromMenu(Promise.resolve("# Plan"), () => downloads++);
    expect(clipboard).toEqual(["write:# Plan"]);
    expect(successes).toEqual(["Contents copied"]);
    expect(downloads).toBe(0);
  });

  test("a file that cannot be copied toasts the reason with Download instead", async () => {
    let downloads = 0;
    await copyContentsFromMenu(
      Promise.reject(new CopyRejected(TOO_LARGE_TO_COPY)),
      () => downloads++,
    );
    expect(clipboard).toEqual([]);
    expect(successes).toEqual([]);
    expect(errors).toEqual([TOO_LARGE_TO_COPY]);
    expect(errorActions.map((action) => action.label)).toEqual(["Download instead"]);
    errorActions[0]?.onClick();
    expect(downloads).toBe(1);
  });

  test("another failure toasts without a download", async () => {
    await copyContentsFromMenu(Promise.reject(new Error("agent-fs is not connected")), () => {});
    expect(errors).toEqual(["agent-fs is not connected"]);
    expect(errorActions).toEqual([]);
  });
});
