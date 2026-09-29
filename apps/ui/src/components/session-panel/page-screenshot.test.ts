import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// No network: the test link below must not load.
GlobalRegistrator.register({ settings: { disableCSSFileLoading: true } });
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const {
  capturePageScreenshot,
  crossOriginStylesheets,
  keepInScreenshot,
  SCREENSHOT_EXCLUDE_ATTR,
  screenshotFileName,
  screenshotScale,
} = await import("./page-screenshot");

describe("page screenshot", () => {
  test("the file name is a sortable timestamp with an extension the attachment filter allows", () => {
    expect(screenshotFileName(new Date("2026-09-28T23:11:06.789Z"))).toBe(
      "screenshot-2026-09-28T23-11-06.png",
    );
  });

  test("scale follows the pixel ratio, capped at 2x and at a 2560 px longest edge", () => {
    expect(screenshotScale(1000, 800, 1)).toBe(1);
    expect(screenshotScale(1000, 800, 3)).toBe(2);
    expect(screenshotScale(1920, 1080, 2)).toBeCloseTo(2560 / 1920);
    // A very tall page scales down below 1x rather than producing a huge upload.
    expect(screenshotScale(800, 10_000, 1)).toBeCloseTo(0.256);
  });

  test("elements marked data-screenshot-exclude are filtered out, everything else is kept", () => {
    const panel = document.createElement("aside");
    panel.setAttribute(SCREENSHOT_EXCLUDE_ATTR, "");
    const page = document.createElement("main");
    expect(keepInScreenshot(panel)).toBe(false);
    expect(keepInScreenshot(page)).toBe(true);
    expect(keepInScreenshot(document.createTextNode("hi"))).toBe(true);
  });

  test("captures the target, not the panel, and returns a PNG File", async () => {
    const page = document.createElement("main");
    page.style.backgroundColor = "rgb(10, 10, 10)";
    const panel = document.createElement("aside");
    panel.setAttribute(SCREENSHOT_EXCLUDE_ATTR, "");
    page.appendChild(panel);
    document.body.appendChild(page);

    const calls: Array<{ node: HTMLElement; options: Record<string, unknown> }> = [];
    const file = await capturePageScreenshot({
      target: page,
      now: new Date("2026-09-28T23:11:06Z"),
      pixelRatio: 2,
      render: async (node, options) => {
        calls.push({ node, options });
        return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.node).toBe(page);
    expect(calls[0]?.options).toMatchObject({
      backgroundColor: "rgb(10, 10, 10)",
      features: { restoreScrollPosition: true },
    });
    const filter = calls[0]?.options.filter as (n: Node) => boolean;
    expect(filter(panel)).toBe(false);
    expect(filter(page)).toBe(true);

    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("screenshot-2026-09-28T23-11-06.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
    page.remove();
  });

  test("a render failure reaches the caller", async () => {
    const page = document.createElement("main");
    await expect(
      capturePageScreenshot({
        target: page,
        render: async () => {
          throw new Error("tainted canvas");
        },
      }),
    ).rejects.toThrow("tainted canvas");
  });
  test("cross-origin stylesheets are @import-ed for the render only, so web fonts embed", async () => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.example.com/css2?family=Space+Grotesk";
    document.head.appendChild(link);
    expect(crossOriginStylesheets()).toEqual([link.href]);

    let importsDuringRender: string[] = [];
    await capturePageScreenshot({
      target: document.body,
      render: async () => {
        importsDuringRender = [...document.head.querySelectorAll("style")]
          .map((style) => style.textContent ?? "")
          .filter((css) => css.includes("@import"));
        return new Blob([]);
      },
    });
    expect(importsDuringRender).toEqual([`@import url("${link.href}");`]);
    // Gone afterwards: the page is left as it was.
    expect(document.head.innerHTML).not.toContain("@import");

    link.remove();
    expect(crossOriginStylesheets()).toEqual([]);
  });
});
