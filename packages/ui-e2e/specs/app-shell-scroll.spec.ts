import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";

// `layout: "sidebar"` scroll contract at a short viewport, where every page
// below overflows. happy-dom does no layout, so only a real browser proves it:
// a `fill` page scrolls its own panes and nothing above them, and an ordinary
// page scrolls the shell body.

const LINES = 40;

function lines(prefix: string) {
  const keys = Array.from({ length: LINES }, (_, index) => `${prefix}${index}`);
  const elements = Object.fromEntries(
    keys.map((key, index) => [
      key,
      { type: "Text", props: { content: `${prefix} line ${index}` } },
    ]),
  );
  return { keys, elements };
}

const left = lines("left");
const right = lines("right");
const long = lines("long");

const definition = {
  layout: "sidebar",
  models: {},
  queries: {},
  defaultPage: "panes",
  pages: {
    panes: {
      title: "Panes",
      icon: "activity",
      root: "root",
      elements: {
        root: { type: "Stack", props: { fill: true }, children: ["split"] },
        split: {
          type: "Split",
          props: { fill: true, ratio: "1-1" },
          children: ["leftPane", "rightPane"],
        },
        leftPane: { type: "Stack", children: left.keys },
        rightPane: { type: "Stack", children: right.keys },
        ...left.elements,
        ...right.elements,
      },
    },
    long: {
      title: "Long",
      icon: "file-text",
      root: "root",
      elements: {
        root: { type: "Stack", children: long.keys },
        ...long.elements,
      },
    },
  },
};

interface ScrollProbe {
  overflows: boolean;
  scrolled: boolean;
}

/** Whether the element overflows, and whether setting scrollTop moves it. */
async function probe(page: Page, selector: string): Promise<ScrollProbe> {
  return page.evaluate((sel) => {
    const el = sel === "document" ? document.scrollingElement : document.querySelector(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    const overflows = el.scrollHeight > el.clientHeight + 1;
    el.scrollTop = 120;
    const scrolled = el.scrollTop > 0;
    el.scrollTop = 0;
    return { overflows, scrolled };
  }, selector);
}

/** The two Split panes: the parents of each pane's first line. */
async function markPanes(page: Page) {
  for (const side of ["left", "right"] as const) {
    const line = page.getByText(`${side} line 0`, { exact: true });
    await expect(line).toBeVisible();
    // Text → pane Stack → Split pane div.
    await line.evaluate((el, name) => {
      el.parentElement?.parentElement?.setAttribute("data-e2e-pane", name);
    }, side);
  }
}

for (const mode of ["default", "full", "chromeless"] as const) {
  test(`app shell ${mode}: fill page scrolls its panes, other pages scroll the shell body`, async ({
    page,
    api,
    seed,
    clean,
  }) => {
    test.skip(!seed, "remote run without seed");
    const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
      name: `e2e-shell-scroll-${mode}`,
      definition,
    });
    try {
      await page.setViewportSize({ width: 1280, height: 400 });
      const query = mode === "default" ? "" : `?mode=${mode}`;
      await page.goto(`/apps/${app.id}${query}`);
      await expect(page.getByTestId("app-shell")).toBeVisible();

      await markPanes(page);
      // Each pane scrolls on its own; the other pane stays put.
      for (const [own, other] of [
        ["left", "right"],
        ["right", "left"],
      ] as const) {
        const pane = await probe(page, `[data-e2e-pane="${own}"]`);
        expect(pane, `${own} pane`).toEqual({ overflows: true, scrolled: true });
        await page.locator(`[data-e2e-pane="${own}"]`).evaluate((el) => {
          el.scrollTop = 120;
        });
        expect(
          await page.locator(`[data-e2e-pane="${other}"]`).evaluate((el) => el.scrollTop),
        ).toBe(0);
        await page.locator(`[data-e2e-pane="${own}"]`).evaluate((el) => {
          el.scrollTop = 0;
        });
      }
      // Nothing above the panes scrolls: not the shell body, not the page.
      expect(await probe(page, '[data-testid="app-shell-body"]'), "body on fill page").toEqual({
        overflows: false,
        scrolled: false,
      });
      expect(await probe(page, "document"), "document on fill page").toEqual({
        overflows: false,
        scrolled: false,
      });

      // An ordinary page: the shell body is the scroll container, the page is not.
      await page
        .getByTestId("app-shell-sidebar")
        .getByRole("link", { name: "Long", exact: true })
        .click();
      await expect(page.getByText("long line 0", { exact: true })).toBeVisible();
      expect(await probe(page, '[data-testid="app-shell-body"]'), "body on long page").toEqual({
        overflows: true,
        scrolled: true,
      });
      expect(await probe(page, "document"), "document on long page").toEqual({
        overflows: false,
        scrolled: false,
      });
      // The header stays in view while the body scrolls.
      await page.getByTestId("app-shell-body").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(page.getByTestId("app-shell-header")).toBeInViewport();
      await clean.assertClean();
    } finally {
      await api.delete(`/api/apps/${app.id}`);
    }
  });
}
