// biome-ignore-all lint/suspicious/noExplicitAny: scratch e2e fixtures read untyped JSON
// Copy to packages/ui-e2e/specs/gap-request-composition.spec.ts in a checkout of the #2458 branch (needs its request-composition API), then:
// PLAYWRIGHT_BROWSERS_PATH=<browsers> bun run e2e:ui -- specs/gap-request-composition.spec.ts
import { expect, test } from "../fixtures";

// PR #2471 on the branch of #2458 (the manifest API): the Usage toggle shows a "Request
// composition" rail panel and a per-call stacked bar behind the cache chip.
// Controls: a task with no manifest has no panel.
test.use({ viewport: { width: 1440, height: 900 } });

const SESSION = "e2e-composition-session";
const PROMPT_TOKENS = 90_690;

function stamp(seconds: number): string {
  return new Date(Date.parse("2026-10-31T10:00:00.000Z") + seconds * 1000).toISOString();
}

test("request composition panel and per-call bar", async ({ page, swarm, seed, clean }) => {
  test.skip(!seed, "remote run without seed");
  const headers = { Authorization: `Bearer ${swarm.apiKey}`, "Content-Type": "application/json" };
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const response = await fetch(`${swarm.apiUrl}${path}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as any };
  };

  const worker = await call("POST", "/api/agents", {
    name: "e2e-comp-worker",
    role: "worker",
    status: "online",
  });
  expect(worker.status).toBe(201);
  const agentId = String(worker.json.id);
  const make = async (task: string) => {
    const created = await call("POST", "/api/tasks", {
      task,
      agentId,
      routingReason: "human_pinned",
    });
    expect(created.status).toBe(201);
    return String(created.json.id);
  };
  const withManifest = await make("e2e composition task");
  const polled = await call("GET", "/api/poll", undefined, { "X-Agent-ID": agentId });
  expect(polled.status).toBe(200);
  const without = await make("e2e plain task without manifest");

  const assistant = {
    type: "assistant",
    timestamp: stamp(1),
    message: {
      id: "msg_comp_1",
      role: "assistant",
      usage: {
        input_tokens: 6,
        cache_read_input_tokens: 90_000,
        cache_creation_input_tokens: 684,
        output_tokens: 120,
      },
      content: [
        { type: "text", text: "Composition probe reply" },
        {
          type: "tool_use",
          id: "toolu_comp_1",
          name: "Agent",
          input: { description: "Inspect fixtures", prompt: "Look", subagent_type: "researcher" },
        },
      ],
    },
  };
  for (const taskId of [withManifest, without]) {
    const logs = await call("POST", "/api/session-logs", {
      sessionId: `${SESSION}-${taskId}`,
      iteration: 1,
      taskId,
      cli: "claude",
      lines: [
        JSON.stringify(assistant),
        JSON.stringify({
          type: "user",
          timestamp: stamp(3),
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_comp_1", content: "Done." }],
          },
        }),
      ],
    });
    expect([200, 201]).toContain(logs.status);
  }

  // Control on the API: no manifest yet -> empty list.
  const empty = await call("GET", `/api/tasks/${withManifest}/request-composition`);
  expect(empty.status).toBe(200);
  expect(empty.json.manifests).toEqual([]);

  const posted = await call(
    "POST",
    `/api/tasks/${withManifest}/request-composition`,
    {
      sessionId: `${SESSION}-${withManifest}`,
      provider: "claude",
      toolLoading: "none",
      parts: [
        {
          kind: "system_section",
          id: "identity",
          label: "Agent identity",
          chars: 4000,
          fidelity: "exact",
        },
        {
          kind: "system_section",
          id: "tools",
          label: "Tool guidance",
          chars: 8000,
          fidelity: "exact",
        },
      ],
    },
    { "X-Agent-ID": agentId },
  );
  expect(posted.status).toBe(200);

  await page.addInitScript(() => localStorage.setItem("swarm:v1:session-log:usage-details", "on"));
  await page.goto(`/tasks/${withManifest}`);
  await expect(page.getByText("Composition probe reply").filter({ visible: true })).toBeVisible();

  const panel = page.getByTestId("request-composition").filter({ visible: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("composition-row").first()).toBeVisible();
  await page.screenshot({ path: "test-results/gap-2471-panel.png", fullPage: true });

  // The chip lives in the raw log view (?log=raw), behind the Usage toggle.
  await page.goto(`/tasks/${withManifest}?log=raw`);
  await expect(page.getByText("Composition probe reply").filter({ visible: true })).toBeVisible();
  const chip = page.getByTestId("call-usage-chip").filter({ visible: true }).first();
  await expect(chip).toBeVisible();
  await chip.click();
  const segments = page.getByTestId("call-composition-segment");
  await expect(segments.first()).toBeVisible();
  const tokens = await segments.evaluateAll((els) =>
    els.map((el) => Number(el.getAttribute("data-tokens"))),
  );
  const groups = await segments.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-group")),
  );
  expect(groups).toContain("system");
  expect(groups).toContain("harness");
  expect(Math.abs(tokens.reduce((a, b) => a + b, 0) - PROMPT_TOKENS)).toBeLessThan(1);
  await page.screenshot({ path: "test-results/gap-2471-popover.png", fullPage: true });

  // Control: a task with no manifest shows no composition panel.
  await page.goto(`/tasks/${without}`);
  await expect(page.getByText("Composition probe reply").filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId("request-composition")).toHaveCount(0);

  await clean.assertClean();
});
