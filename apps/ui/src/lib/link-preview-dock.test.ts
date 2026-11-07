import { describe, expect, test } from "bun:test";
import {
  clampPreviewWidth,
  PREVIEW_DEFAULT_WIDTH,
  PREVIEW_MIN_WIDTH,
  previewDockLayout,
} from "./link-preview-dock";

// The task page's wide row at a 1600 px window (nav open), and at 1280 px
// (nav collapsed to icons while a preview is open); the transcript and the
// details card need 720 px next to the preview.
const TASK_SIBLING_MIN = 720;

describe("previewDockLayout", () => {
  test("a wide task page keeps the preview inline next to the transcript and details", () => {
    const at1600 = previewDockLayout({
      rowWidth: 1320,
      viewportWidth: 1600,
      siblingMinWidth: TASK_SIBLING_MIN,
    });
    expect(at1600).toEqual({ inline: true, min: PREVIEW_MIN_WIDTH, max: 600 });
    const at1280 = previewDockLayout({
      rowWidth: 1208,
      viewportWidth: 1280,
      siblingMinWidth: TASK_SIBLING_MIN,
    });
    expect(at1280.inline).toBe(true);
    expect(at1280.max).toBe(488);
  });

  test("a hidden row (the task page under its wide breakpoint) opens a sheet", () => {
    const layout = previewDockLayout({
      rowWidth: 0,
      viewportWidth: 1024,
      siblingMinWidth: TASK_SIBLING_MIN,
    });
    expect(layout.inline).toBe(false);
  });

  test("a row without room for the preview's minimum opens a sheet", () => {
    const layout = previewDockLayout({
      rowWidth: TASK_SIBLING_MIN + PREVIEW_MIN_WIDTH - 1,
      viewportWidth: 1400,
      siblingMinWidth: TASK_SIBLING_MIN,
    });
    expect(layout.inline).toBe(false);
  });

  test("the cap is 70% of the window on a very wide row", () => {
    const layout = previewDockLayout({ rowWidth: 3000, viewportWidth: 1000, siblingMinWidth: 0 });
    expect(layout.max).toBe(700);
  });

  test("the cap never drops under the minimum, so a narrow row cannot shrink a saved width", () => {
    const layout = previewDockLayout({ rowWidth: 500, viewportWidth: 500, siblingMinWidth: 400 });
    expect(layout.max).toBe(PREVIEW_MIN_WIDTH);
    expect(layout.max).toBeGreaterThanOrEqual(layout.min);
  });
});

describe("clampPreviewWidth", () => {
  const layout = { inline: true, min: PREVIEW_MIN_WIDTH, max: 600 };

  test("no stored width takes the default", () => {
    expect(clampPreviewWidth(null, layout)).toBe(PREVIEW_DEFAULT_WIDTH);
    expect(clampPreviewWidth(Number.NaN, layout)).toBe(PREVIEW_DEFAULT_WIDTH);
    expect(clampPreviewWidth(0, layout)).toBe(PREVIEW_DEFAULT_WIDTH);
  });

  test("a drag past the bounds stops at them", () => {
    expect(clampPreviewWidth(100, layout)).toBe(PREVIEW_MIN_WIDTH);
    expect(clampPreviewWidth(2000, layout)).toBe(600);
    expect(clampPreviewWidth(512.4, layout)).toBe(512);
  });
});
