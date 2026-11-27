import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures";

// The connect steps and four image chips share a fixed-height thread on a phone.
// happy-dom does no layout: only a real browser proves the buttons stay in view.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const FILES = [1, 2, 3, 4].map((n) => ({
  name: `phone-layout-example-${n}.png`,
  mimeType: "image/png",
  buffer: PNG,
}));

const definition = {
  models: {},
  queries: {},
  actions: { reply: { kind: "task", prompt: "Answer the message" } },
  defaultPage: "main",
  pages: {
    main: {
      root: "thread",
      elements: {
        thread: {
          type: "SessionThread",
          props: {
            id: "thread",
            sessionKey: "main",
            attachments: {
              dir: "/e2e/attachments",
              accept: [".png"],
              maxFiles: 10,
              maxBytes: 10485760,
            },
            onDispatch: [{ action: "app.action", params: { name: "reply", input: { $form: "" } } }],
          },
        },
      },
    },
  },
};

/** Comb on, with a stubbed agent-fs server, and no key in this browser: the steps show. */
async function stubAgentFs(page: Page, apiUrl: string, baseURL: string) {
  const agentFs = `${baseURL}/e2e-agent-fs`;
  await page.route(`${apiUrl}/status`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.agent_fs = {
      ...(body.agent_fs ?? {}),
      configured: true,
      comb: {
        enabled: true,
        reason: null,
        api_url: agentFs,
        live_url: agentFs,
        org_id: "e2e-org",
        drive_id: "e2e-drive",
        review_follow_ups: false,
        service_user_id: null,
      },
    };
    await route.fulfill({ response, json: body });
  });
  await page.route(`${apiUrl}/api/fs/me`, (route) =>
    route.fulfill({ json: { status: "ready", orgId: "e2e-org", driveId: "e2e-drive" } }),
  );
  // Never connects, so the steps stay up.
  await page.route(`${apiUrl}/api/fs/keys`, (route) =>
    route.fulfill({ status: 503, json: { error: "e2e: no key" } }),
  );
  await page.route(`${agentFs}/**`, (route) =>
    route.fulfill({ json: { version: "0.19.0", features: [], maxUploadBytes: 52428800 } }),
  );
}

/** Fully inside the thread, and a tap on its center lands on it. */
async function expectReachable(thread: Locator, button: Locator) {
  const box = await thread.boundingBox();
  const target = await button.boundingBox();
  if (!box || !target) throw new Error("the thread or the button did not render");
  expect(target.y, "button top inside the thread").toBeGreaterThanOrEqual(box.y);
  expect(target.y + target.height, "button bottom inside the thread").toBeLessThanOrEqual(
    box.y + box.height,
  );
  const hit = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return at !== null && element.contains(at);
  });
  expect(hit, "a tap on the button's center hits it").toBe(true);
}

async function attachFourAndCheck(page: Page, send: string) {
  const thread = page.getByTestId("json-render-session-thread");
  const steps = thread.getByRole("note").filter({ hasText: "Connect your files" });
  await expect(steps).toBeVisible();
  await thread.locator('input[type="file"]').setInputFiles(FILES);
  await thread.getByRole("textbox").fill("Please review these four screenshots.");
  await expect(thread.getByRole("button", { name: /^Remove phone-layout-example/ })).toHaveCount(4);

  await expectReachable(thread, thread.getByRole("button", { name: send }));
  // The hidden file input carries the same name.
  await expectReachable(thread, thread.locator('button[aria-label="Attach files"]'));
  // The steps gave up their height, and still scroll Connect Files into view.
  const connect = steps.getByRole("button", { name: "Connect Files" });
  await connect.focus();
  await expectReachable(thread, connect);
}

test("phone: four files and the connect steps keep the first message's buttons in view", async ({
  page,
  api,
  swarm,
  baseURL,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-thread-connect-first",
    definition,
  });
  try {
    await stubAgentFs(page, swarm.apiUrl, baseURL as string);
    await page.goto(`/apps/${app.id}`);
    await attachFourAndCheck(page, "Start session");
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});

test("phone: four files and the connect steps keep a session's follow-up buttons in view", async ({
  page,
  api,
  swarm,
  baseURL,
  seed,
  clean,
}) => {
  test.skip(!seed, "remote run without seed");
  const { app } = await api.post<{ app: { id: string } }>("/api/apps", {
    name: "e2e-thread-connect-session",
    definition,
  });
  try {
    // The viewer's session for this thread, already over: its composer takes files.
    const root = await api.post<{ id: string }>("/api/tasks", {
      task: "e2e connect hint session",
      contextKey: `task:app:${app.id}:main:user:${seed?.user.id}`,
      requestedByUserId: seed?.user.id,
    });
    await api.post(`/api/tasks/${root.id}/cancel`, {});
    await stubAgentFs(page, swarm.apiUrl, baseURL as string);
    await page.goto(`/apps/${app.id}`);
    await expect(page.getByRole("button", { name: "New session" })).toBeVisible();
    await attachFourAndCheck(page, "Follow up");
    await clean.assertClean();
  } finally {
    await api.delete(`/api/apps/${app.id}`);
  }
});
