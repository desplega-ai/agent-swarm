import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
});

const { applyUiFont, readStoredUiFont, storeUiFont, UI_FONT_OPTIONS, UI_FONT_STORAGE_KEY } =
  await import("./ui-font");

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-font");
});

test("reads the Hive default when nothing or garbage is stored", () => {
  expect(readStoredUiFont()).toBe("hive");
  localStorage.setItem(UI_FONT_STORAGE_KEY, "comic-sans");
  expect(readStoredUiFont()).toBe("hive");
});

test("a stored choice survives a reload, and the default clears the key", () => {
  storeUiFont("opendyslexic");
  expect(localStorage.getItem(UI_FONT_STORAGE_KEY)).toBe("opendyslexic");
  expect(readStoredUiFont()).toBe("opendyslexic");

  storeUiFont("hive");
  expect(localStorage.getItem(UI_FONT_STORAGE_KEY)).toBeNull();
  expect(readStoredUiFont()).toBe("hive");
});

test("applying sets data-font, and the default removes it", () => {
  const root = document.documentElement;
  applyUiFont("system", root);
  expect(root.getAttribute("data-font")).toBe("system");
  applyUiFont("hive", root);
  expect(root.hasAttribute("data-font")).toBe(false);
});

test("the default and System load no web font; the bundled options do", () => {
  const loaders = Object.fromEntries(
    UI_FONT_OPTIONS.map((option) => [option.id, Boolean(option.load)]),
  );
  expect(loaders).toEqual({
    hive: false,
    system: false,
    atkinson: true,
    opendyslexic: true,
    lexend: true,
  });
});
