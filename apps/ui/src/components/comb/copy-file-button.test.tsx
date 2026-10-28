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
    error: (message: string) => errors.push(message),
    success: () => {},
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

const { CopyFileButton } = await import("./copy-file-button");

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

  test("without ClipboardItem it falls back to writeText", async () => {
    installClipboard(false);
    const view = await mount({ size: 6, contentType: "text/markdown" });
    await view.click();
    expect(clipboard).toEqual(["writeText:# Plan"]);
    expect(view.button().getAttribute("aria-label")).toBe("Contents copied");
  });

  test("a failed load copies nothing and toasts its reason", async () => {
    load = () => Promise.reject(new Error("Can't copy this file type"));
    const view = await mount({ size: 6, contentType: "application/octet-stream" }, "/README");
    await view.click();
    expect(clipboard).toEqual([]);
    expect(errors).toEqual(["Can't copy this file type"]);
    expect(view.button().getAttribute("aria-label")).toBe("Copy contents");
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
