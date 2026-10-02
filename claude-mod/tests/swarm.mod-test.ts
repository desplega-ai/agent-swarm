// Tests for the agent-swarm Claude Code mod. Run: bun run test:claude-mod
// (the `.mod-test.ts` suffix keeps them out of the repo's `bun test` run).
import type { On } from "claude-code";
import { describe, expect, mock, test } from "claude-code/testing";

const TASK_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "66666666-7777-4888-9999-000000000000";
const NEW_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const BASE = "https://api.example.test";
const TOKEN = "Bearer aswt_test";
const POLL = 15_000;
const DOCS = "https://docs.agent-swarm.dev/docs/guides/claude-code-mod";

// ~/.claude.json with the agent-swarm-user entry at local (project) scope.
const CONFIG = {
  mcpServers: {},
  projects: {
    "/work": {
      mcpServers: {
        "agent-swarm-user": {
          type: "http",
          url: `${BASE}/mcp-user`,
          headers: { Authorization: TOKEN },
        },
      },
    },
  },
};

// Three raw session-log rows as a Claude worker stores them.
const LOGS = [
  {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }],
    },
  },
  {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb\nc" }],
    },
  },
  {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Done listing." }] },
  },
].map((event, i) => ({
  id: `log-${i}`,
  taskId: TASK_ID,
  sessionId: "s1",
  iteration: 1,
  cli: "claude",
  content: JSON.stringify(event),
  lineNumber: i,
  createdAt: `2026-10-01T12:00:0${i}.000Z`,
}));

type Call = { method: string; path: string; auth: string | undefined; body: any };
type World = {
  calls: Call[];
  prompts: string[];
  statuses: (string | undefined)[];
  toasts: string[];
  registered: string[];
  closed: string[];
  configReads: number;
  config: unknown;
  status: string;
  output: string;
  isPaneOpen: boolean;
  isUnauthorized: boolean;
};

const reply = (status: number, body: unknown) =>
  ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } }) as any;

// Hooks registered here run beneath the mod and stand in for the engine and the swarm API.
function world(on: On): World {
  const w: World = {
    calls: [],
    prompts: [],
    statuses: [],
    toasts: [],
    registered: [],
    closed: [],
    configReads: 0,
    config: CONFIG,
    status: "in_progress",
    output: "OK from the swarm",
    isPaneOpen: false,
    isUnauthorized: false,
  };
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("tool.register", (_$, e) => {
    w.registered.push(e.name);
    return { value: {} } as any;
  });
  on("command.register", () => ({ value: {} }) as any);
  on("ui.status", (_$, e) => {
    w.statuses.push(e.text);
    return { value: undefined } as any;
  });
  on("ui.toast", (_$, e) => {
    w.toasts.push(e.text);
    return { value: undefined } as any;
  });
  on("ui.open", () => {
    w.isPaneOpen = true;
    return { value: { isPlaced: true } } as any;
  });
  on("ui.close", (_$, e: any) => {
    w.closed.push(e.id);
    w.isPaneOpen = false;
    return { value: undefined } as any;
  });
  on("ui.panes", () => ({ value: w.isPaneOpen ? [{ id: "swarm" }] : [] }) as any);
  on("ui.focus", () => ({}) as any);
  on("ui.render", ($, e) => $.ui.resolve(e).Box({}));
  on("prompt.submit", (_$, e) => {
    w.prompts.push(e.text);
    return { text: e.text };
  });
  on("env.get", (_$, e) => ({ value: e.name === "HOME" ? "/home/me" : undefined }) as any);
  on("fs.read", (_$, e) => {
    w.configReads++;
    return { value: e.path === "/home/me/.claude.json" ? JSON.stringify(w.config) : "{}" } as any;
  });
  on("http.fetch", (_$, e) => {
    const url = new URL(e.url);
    const method = e.init?.method ?? "GET";
    w.calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      auth: e.init?.headers?.Authorization,
      body: e.init?.body ? JSON.parse(e.init.body) : undefined,
    });
    if (url.origin !== BASE) return reply(404, { error: "wrong host" });
    if (w.isUnauthorized) return reply(401, { error: "Unauthorized" });
    if (method === "GET" && url.pathname === "/api/whoami")
      return reply(200, { kind: "user", user: { id: "user-1" } });
    if (method === "POST" && url.pathname === "/api/tasks") {
      const isFirst = !w.calls
        .slice(0, -1)
        .some((c) => c.method === "POST" && c.path === "/api/tasks");
      return reply(201, {
        id: isFirst ? TASK_ID : NEW_ID,
        status: "pending",
        requestedByUserId: "user-1",
      });
    }
    if (
      method === "GET" &&
      (url.pathname === `/api/tasks/${TASK_ID}` || url.pathname === `/api/tasks/${NEW_ID}`)
    ) {
      return reply(200, {
        id: url.pathname.split("/").at(-1),
        status: w.status,
        progress: "⚡ Working",
        output: w.output,
      });
    }
    if (method === "GET" && url.pathname === `/api/tasks/${TASK_ID}/session-logs`)
      return reply(200, { logs: LOGS });
    if (method === "GET" && url.pathname === "/api/tasks") {
      return reply(200, {
        tasks: [
          {
            id: OTHER_ID,
            status: "in_progress",
            task: "<thread_context>\nFix the Azure DevOps 500",
            progress: null,
          },
        ],
      });
    }
    if (method === "POST" && url.pathname === `/api/tasks/${TASK_ID}/cancel`)
      return reply(200, { success: true });
    return reply(404, { error: `no route ${method} ${url.pathname}` });
  });
  return w;
}

const start = ($: any, isInteractive = true) =>
  $.session.start({ surface: "terminal", isInteractive, cwd: "/work" } as any);

const delegate = ($: any) =>
  $.tool.call({
    tool: "mcp__agent-swarm__delegate",
    task: "Reply with OK.",
    tier: "smol",
    title: "ok test",
  } as any);

const mountPane = ($: any) =>
  $.ui.mount({
    plugin: "agent-swarm",
    surface: "terminal",
    component: "Pane",
    requestId: "swarm",
    props: { title: "Swarm", isFocused: true, bodyColumns: 100, placement: "dock" },
  } as any);

describe("agent-swarm mod", () => {
  test("delegates over REST with the MCP entry token, follows the task and hands its result to Claude once", async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse("2026-10-01T12:00:00Z") });
    const w = world(on);
    await start($);
    expect(w.registered).toEqual(["delegate"]);

    const sent = await delegate($);
    expect(sent.deny).toBeUndefined();
    expect(String(sent.result)).toContain(TASK_ID);
    const create = w.calls.find((c) => c.method === "POST" && c.path === "/api/tasks")!;
    expect(create.auth).toBe(TOKEN);
    expect(create.body.modelTier).toBe("smol");
    expect(create.body.task).toContain("compact final answer");
    expect(create.body.tags[0]).toBe("claude-code");
    expect(create.body.tags[1]).toMatch(/^cc:[0-9a-f]{8}$/);
    expect(w.statuses.at(-1)).toBe("1 running · ctrl+x w");

    await clock.advance(POLL);
    expect(w.prompts).toHaveLength(0);

    w.status = "completed";
    await clock.advance(POLL);
    expect(w.prompts).toHaveLength(1);
    expect(w.prompts[0]).toContain(
      `<swarm-task-result id="${TASK_ID}" status="completed" title="ok test">`,
    );
    expect(w.prompts[0]).toContain("OK from the swarm");
    expect(w.statuses.at(-1)).toBeUndefined();

    // Later polls, with the pane open too, never report it again.
    w.isPaneOpen = true;
    await clock.advance(POLL);
    await clock.advance(POLL);
    expect(w.prompts).toHaveLength(1);
    expect(w.configReads).toBe(1);
  });

  test("cuts a very long output and says where the rest is", async ($, on) => {
    const clock = mock.clock(on, { now: 0 });
    const w = world(on);
    w.output = "x".repeat(25_000);
    await start($);
    await delegate($);
    w.status = "completed";
    await clock.advance(POLL);
    expect(w.prompts[0]).toContain(
      `[cut at 20000 characters; the full output is on swarm task ${TASK_ID}]`,
    );
  });

  test("a 401 shows in the status line and re-reads the token next time", async ($, on) => {
    const clock = mock.clock(on, { now: 0 });
    const w = world(on);
    await start($);
    await delegate($);
    w.isUnauthorized = true;
    await clock.advance(POLL);
    expect(w.statuses.at(-1)).toContain("HTTP 401");
    w.isUnauthorized = false;
    await clock.advance(POLL);
    expect(w.statuses.at(-1)).toBe("1 running · ctrl+x w");
    expect(w.configReads).toBeGreaterThan(1);
  });

  test("stays off in a headless session", async ($, on) => {
    mock.clock(on, { now: 0 });
    const w = world(on);
    await start($, false);
    expect(w.registered).toEqual([]);
    expect((await delegate($)).deny).toContain("interactive");
    expect(w.calls).toHaveLength(0);
  });

  test("not set up: no tool, and /swarm shows the setup guide", async ($, on) => {
    mock.clock(on, { now: 0 });
    const w = world(on);
    w.config = { mcpServers: {} };
    await start($);
    expect(w.registered).toEqual([]);
    const ran = await $.command.run({ command: "swarm", args: "" } as any);
    expect(String((ran as any).text)).toContain(DOCS);
    const pane = await mountPane($);
    expect(await pane.find({ type: "Text", text: /not set up/ })).toBeDefined();
    expect(
      await pane.find({ type: "Text", text: new RegExp(DOCS.replace(/[.]/g, "\\.")) }),
    ).toBeDefined();
    await pane.unmount();
  });

  test(
    "falls back to the plugin config when there is no MCP entry",
    { options: { swarmUrl: `${BASE}/`, swarmToken: "aswt_cfg" } } as any,
    async ($: any, on: any) => {
      mock.clock(on, { now: 0 });
      const w = world(on);
      w.config = {};
      await start($);
      await delegate($);
      const create = w.calls.find((c) => c.method === "POST" && c.path === "/api/tasks")!;
      expect(create.auth).toBe("Bearer aswt_cfg");
    },
  );

  test("/swarm toggles the pane", async ($, on) => {
    mock.clock(on, { now: 0 });
    const w = world(on);
    await start($);
    await $.command.run({ command: "swarm", args: "" } as any);
    expect(w.isPaneOpen).toBe(true);
    await $.command.run({ command: "swarm", args: "" } as any);
    expect(w.closed).toEqual(["swarm"]);
  });

  test("the pane groups tasks, moves with j/k, tails a log and cancels", async ($, on) => {
    mock.clock(on, { now: 0 });
    const w = world(on);
    await start($);
    await delegate($);
    w.status = "pending";
    await $.command.run({ command: "swarm", args: "" } as any);
    expect(
      w.calls.some(
        (c) => c.path.startsWith("/api/tasks?") && c.path.includes("requestedByUserId=user-1"),
      ),
    ).toBe(true);

    const pane = await mountPane($);
    expect(await pane.find({ type: "Text", text: /── In progress · 1/ })).toBeDefined();
    expect(await pane.find({ type: "Text", text: /── Queued · 1/ })).toBeDefined();
    expect(await pane.find({ key: `row-${OTHER_ID}` })).toBeDefined();
    // The row label skips the `<thread_context>` wrapper line.
    expect(
      await pane.find({ type: "Button", text: /Fix the Azure DevOps 500/ } as any),
    ).toBeDefined();

    await pane.press({ key: "key-j" });
    await pane.press({ key: "key-c" });
    const cancel = w.calls.find((c) => c.path === `/api/tasks/${TASK_ID}/cancel`)!;
    expect(cancel.body.reason).toContain("/swarm pane");

    await pane.press({ key: `row-${TASK_ID}` });
    expect(await pane.find({ type: "Text", text: /⚙ Bash ls -la/ })).toBeDefined();
    expect(await pane.find({ type: "Text", text: /↳ a \(\+2 lines\)/ })).toBeDefined();
    expect(await pane.find({ type: "Text", text: /◆ Done listing\./ })).toBeDefined();
    await pane.press({ key: "key-h" });
    expect(await pane.find({ type: "Text", text: /── Queued/ })).toBeDefined();
    await pane.unmount();
  });

  test("search asks the API, and a new task from the pane only toasts when done", async ($, on) => {
    const clock = mock.clock(on, { now: 0 });
    const w = world(on);
    await start($);
    await $.command.run({ command: "swarm", args: "" } as any);
    const pane = await mountPane($);

    await pane.press({ key: "key-f" });
    await pane.input({ key: "search", text: "azure", kind: "change" } as any);
    await pane.input({ key: "search", text: "azure" } as any);
    expect(
      w.calls.some((c) => c.path.startsWith("/api/tasks?") && c.path.includes("search=azure")),
    ).toBe(true);
    await pane.press({ key: "key-x" });

    await pane.press({ key: "key-n" });
    await pane.input({ key: "new", text: "Write the release notes" } as any);
    const create = w.calls.filter((c) => c.method === "POST" && c.path === "/api/tasks").at(-1)!;
    expect(create.body.task).toBe("Write the release notes");
    expect(w.toasts.some((t) => t.includes("sent"))).toBe(true);

    w.status = "completed";
    await clock.advance(POLL);
    expect(w.prompts).toHaveLength(0);
    expect(w.toasts.some((t) => t.includes("completed"))).toBe(true);
    await pane.unmount();
  });
});
