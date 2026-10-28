import { expect, test } from "../fixtures";

test.use({ video: "on" });

interface SessionFrame {
  loading: boolean;
  sidebar: string | null;
}

declare global {
  interface Window {
    setupSessionFrames: SessionFrame[];
  }
}

for (const width of [1280, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`setup handoff ${width}px ${colorScheme}`, () => {
      test.use({
        viewport: { width, height: width === 390 ? 844 : 800 },
        colorScheme,
        reducedMotion: width === 390 && colorScheme === "dark" ? "reduce" : "no-preference",
      });
      test.describe.configure({ retries: 0 });

      test("first task paints the session without a loading frame @local", async ({
        page,
        seed,
        clean,
      }, testInfo) => {
        test.skip(!seed, "local seeded API required");
        // The worker API is reused, so give each browser a fresh first-task view.
        // Task creation and both setup actions still go to the real API.
        let sent = false;
        await page.route("**/api/onboarding", async (route) => {
          const request = route.request();
          if (request.method() === "GET" && !sent) {
            const response = await route.fetch();
            const data = await response.json();
            data.state.firstTaskId = null;
            data.signals.firstTask = null;
            data.state.steps.first_task.status = "todo";
            await route.fulfill({ response, json: data });
          } else {
            if (request.method() === "PUT" && request.postDataJSON().action === "first_task") {
              sent = true;
            }
            await route.continue();
          }
        });

        // A cold CDN makes the lazy-route frame observable on every run.
        await page.route("**/assets/*.js", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await route.continue();
        });
        await page.addInitScript(() => {
          window.setupSessionFrames = [];
          const sample = () => {
            const main = document.querySelector("#main-content");
            if (location.pathname.startsWith("/sessions/") && main) {
              window.setupSessionFrames.push({
                loading: Boolean(main.querySelector(".hive-loading-float")),
                sidebar:
                  document
                    .querySelector('[data-slot="sidebar"][data-state]')
                    ?.getAttribute("data-state") ?? null,
              });
            }
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });

        await page.goto("/setup?step=first_task");
        if (colorScheme === "light") {
          await page.getByRole("button", { name: "Switch to light mode", exact: true }).click();
        }
        const task = "e2e first task session handoff";
        await page.getByPlaceholder("Describe a goal for the swarm").fill(task);
        await page.getByRole("button", { name: "Send first task", exact: true }).click();
        await expect(page).toHaveURL(/\/sessions\/[^/?]+/);
        await page.screenshot({ path: testInfo.outputPath("handoff.png") });
        await expect(page.locator("#main-content")).toContainText(task);
        await expect
          .poll(() => page.evaluate(() => window.setupSessionFrames.length))
          .toBeGreaterThan(0);
        const frames = await page.evaluate(() => window.setupSessionFrames);
        await testInfo.attach("session-paint-frames", {
          body: JSON.stringify(frames, null, 2),
          contentType: "application/json",
        });
        await page.screenshot({ path: testInfo.outputPath("session.png") });
        expect(
          frames.filter((frame) => frame.loading),
          "painted route-loading frames",
        ).toEqual([]);
        if (width >= 768) {
          expect(
            frames.map((frame) => frame.sidebar),
            "sidebar is collapsed from the first paint",
          ).toEqual(frames.map(() => "collapsed"));
          // The route's temporary hold must restore the user's expanded nav.
          await page
            .locator('[data-slot="sidebar"]')
            .getByRole("link", { name: "Home", exact: true })
            .click();
          await expect(page.locator('[data-slot="sidebar"][data-state]')).toHaveAttribute(
            "data-state",
            "expanded",
          );
        }
        await clean.assertClean();
      });
    });
  }
}
