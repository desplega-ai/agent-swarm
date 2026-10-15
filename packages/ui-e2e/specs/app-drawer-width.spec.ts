import { expect, test } from "../fixtures";

const widths = [375, 640, 768, 1024, 1440, 2560];
const sizes = [
  { size: "sm", floor: 384, ratio: 0.33333, cap: 640 },
  { size: "md", floor: 448, ratio: 0.46, cap: 960 },
  { size: "lg", floor: 672, ratio: 0.62, cap: 1280 },
  { size: "xl", floor: 896, ratio: 0.7, cap: 1600 },
] as const;

for (const side of ["left", "right"] as const) {
  for (const { size, floor, ratio, cap } of sizes) {
    test(`app Drawer ${side} ${size} preserves tablet width and grows on desktop`, async ({
      page,
      api,
      seed,
      clean,
    }) => {
      test.skip(!seed, "remote run without seed");
      const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
        name: `e2e-drawer-${side}-${size}`,
        definition: {
          models: {},
          queries: {},
          pages: {
            main: {
              params: { item: { kind: "string" } },
              root: "drawer",
              elements: {
                drawer: {
                  type: "Drawer",
                  props: { param: "item", title: "Item detail", side, size },
                },
              },
            },
          },
          defaultPage: "main",
        },
      });
      try {
        await page.goto(`/apps/${app.id}?item=example`);
        const drawer = page.getByRole("dialog", { name: "Item detail" });
        await expect(drawer).toBeVisible();
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          const expected =
            width < 640 ? width : Math.min(width, cap, Math.max(floor, width * ratio));
          await expect
            .poll(async () => (await drawer.boundingBox())?.width)
            .toBeCloseTo(expected, 0);
          await expect
            .poll(async () => {
              const box = await drawer.boundingBox();
              return box && (side === "left" ? box.x : box.x + box.width);
            })
            .toBeCloseTo(side === "left" ? 0 : width, 0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        }
        await clean.assertClean();
      } finally {
        await api.delete(`/api/apps/${app.id}`);
      }
    });
  }
}
