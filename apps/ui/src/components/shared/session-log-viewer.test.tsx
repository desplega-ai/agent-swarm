import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { SessionLog } from "@/api/types";

// A DOM for the client render; removed after this file so other files keep
// their server-render environment. The data router builds a `Request` with an
// `AbortSignal`. Mixed Bun and happy-dom classes reject each other, so keep
// Bun's three.
const {
  Request: BunRequest,
  AbortController: BunAbortController,
  AbortSignal: BunAbortSignal,
} = globalThis;
GlobalRegistrator.register();
Object.assign(globalThis, {
  Request: BunRequest,
  AbortController: BunAbortController,
  AbortSignal: BunAbortSignal,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// The root `bun test` does not resolve the UI's `@/` alias, and the viewer
// pulls these in, directly or through its imports. Each maps to the real module.
const SRC = new URL("../../", import.meta.url).pathname;
for (const alias of [
  "@/components/kibo-ui/spinner",
  "@/components/shared/animated-reveal",
  "@/components/shared/inline-identifier-code",
  "@/components/shared/json-tree",
  "@/components/shared/session-log-messages",
  "@/components/shared/subagent-waterfall",
  "@/components/shared/task-status-icon",
  "@/components/shared/tool-result-image",
  "@/components/shared/use-log-scroll",
  "@/components/steering/queued-steering-box",
  "@/components/steering/steering-message-chips",
  "@/components/ui/badge",
  "@/components/ui/button",
  "@/components/ui/collapsible",
  "@/components/ui/dialog",
  "@/components/ui/input",
  "@/components/ui/segmented-control",
  "@/components/ui/spinner",
  "@/components/ui/tabs",
  "@/components/ui/tooltip",
  "@/components/ui/trace",
  "@/hooks/use-copy-to-clipboard",
  "@/hooks/use-theme",
  "@/hooks/use-url-search-state",
  "@/lib/format-tokens",
  "@/lib/json-output",
  "@/lib/session-log-usage-details",
  "@/lib/status-labels",
  "@/lib/themes",
  "@/lib/utils",
  "@/logs-parser",
  "@/logs-parser/result-images",
]) {
  const path = Bun.resolveSync(`./${alias.slice(2)}`, SRC);
  mock.module(alias, () => require(path));
}

// react-dom must load after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { createMemoryRouter, RouterProvider } = await import("react-router-dom");
const { SessionLogViewer } = await import("./session-log-viewer");
const { setUsageDetails } = await import("@/lib/session-log-usage-details");

const ISO = "2026-10-05T11:36:33.000Z";

function at(seconds: number): string {
  return new Date(Date.parse(ISO) + seconds * 1000).toISOString();
}

function claude(id: string, lineNumber: number, event: Record<string, unknown>): SessionLog {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    iteration: 1,
    cli: "claude",
    content: JSON.stringify({ timestamp: at(lineNumber), ...event }),
    lineNumber,
    createdAt: at(lineNumber),
  } as SessionLog;
}

const usage = {
  input_tokens: 6,
  cache_read_input_tokens: 90_000,
  cache_creation_input_tokens: 684,
  output_tokens: 120,
};

// An assistant line with usage whose only block is an Agent call: its
// `call_usage` has no tool or text row to ride on, so the run's row shows it.
const logs: SessionLog[] = [
  claude("spawn", 1, {
    type: "assistant",
    message: {
      id: "msg_spawn",
      role: "assistant",
      usage,
      content: [
        {
          type: "tool_use",
          id: "toolu_agent_1",
          name: "Agent",
          input: { description: "Inspect fixtures", prompt: "Look", subagent_type: "researcher" },
        },
      ],
    },
  }),
  claude("result", 3, {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_agent_1", content: "Done." }],
    },
  }),
];

// 90,000 read of 90,690 prompt tokens.
const SPAWN_CHIP = "99% cached · 90.7K in · +684 written";

const unmounts: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  localStorage.clear();
});

async function mount(trace: boolean) {
  const router = createMemoryRouter(
    [{ path: "/", element: <SessionLogViewer logs={logs} trace={trace} /> }],
    { initialEntries: ["/"] },
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => {});
  unmounts.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  // The run's row, `subagent-<Agent call id>`.
  return () => container.querySelector('[data-row-id="subagent-toolu_agent_1"]')?.textContent ?? "";
}

describe("SessionLogViewer sub-agent row usage", () => {
  for (const trace of [false, true]) {
    const layout = trace ? "trace" : "default";

    test(`${layout} layout: an Agent-only call's usage shows on the run's row`, async () => {
      setUsageDetails(true);
      const runRowText = await mount(trace);
      expect(runRowText()).toContain("Inspect fixtures");
      expect(runRowText()).toContain(SPAWN_CHIP);
    });

    test(`${layout} layout: the chip stays hidden with usage details off`, async () => {
      setUsageDetails(false);
      const runRowText = await mount(trace);
      expect(runRowText()).toContain("Inspect fixtures");
      expect(runRowText()).not.toContain("cached");
    });
  }
});
