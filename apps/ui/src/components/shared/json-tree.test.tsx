import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

mock.module("@/hooks/use-copy-to-clipboard", () => require("../../hooks/use-copy-to-clipboard"));
mock.module("@/lib/json-output", () => require("../../lib/json-output"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { JsonTree } = await import("./json-tree");

let clipboard: string | null = null;
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      clipboard = text;
    },
  },
});

beforeEach(() => {
  clipboard = null;
  document.body.innerHTML = "";
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function copyValueButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy value"]')];
}

test("copying an empty-string node replaces the previous clipboard value", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<JsonTree data={{ name: "Ada", empty: "" }} copyable />));

  const [nameButton, emptyButton] = copyValueButtons();
  await act(async () => nameButton?.click());
  expect(clipboard).toBe("Ada");

  await act(async () => emptyButton?.click());
  expect(clipboard).toBe("");
  expect(emptyButton?.getAttribute("aria-label")).toBe("Copied");

  await act(async () => root.unmount());
});
