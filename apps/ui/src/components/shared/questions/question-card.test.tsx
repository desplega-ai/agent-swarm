import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MotionGlobalConfig } from "motion/react";
import { act, useLayoutEffect } from "react";
import type { SignedUrlResult, StatResult } from "../../../lib/agent-fs/types";

// A DOM at a dashboard origin, so `/file/~/` links parse as drive files;
// removed after this file so other files keep their server-render environment.
const DASHBOARD = "https://app.test";
GlobalRegistrator.register({ url: `${DASHBOARD}/approval-requests/r1` });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// react-dom reads the DOM when it first loads: import it after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AgentFsError } = await import("../../../lib/agent-fs/client");
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));
MotionGlobalConfig.skipAnimations = true;
afterAll(async () => {
  MotionGlobalConfig.skipAnimations = false;
  await GlobalRegistrator.unregister();
});

/**
 * A fake agent-fs client. `stat` answers from `stats` or throws the error in
 * `statErrors` (404 when neither has the path); `signed-url` mints a
 * presigned URL for any path. Every call is recorded.
 */
const stats: Record<string, StatResult> = {};
const statErrors: Record<string, Error> = {};
const calls: string[] = [];
const fakeClient = {
  async callOp(_orgId: string, op: string, params: { path: string }) {
    calls.push(`${op} ${params.path}`);
    const error = statErrors[params.path];
    if (error) throw error;
    const hit = stats[params.path];
    if (!hit) throw new AgentFsError(404, "NOT_FOUND", `${params.path} not found`);
    return hit;
  },
  async getSignedUrl(_orgId: string, _driveId: string, path: string): Promise<SignedUrlResult> {
    calls.push(`signed-url ${path}`);
    return {
      url: `https://bucket.test${path}?sig=1`,
      path,
      expiresIn: 3600,
      expiresAt: "",
      kind: "presigned",
    } as SignedUrlResult;
  },
  async fetchRaw(): Promise<Blob> {
    throw new Error("blob mode is not used here");
  },
};

/** The agent-fs context: null with no provider, else connected (`ready`) or not. */
let agentFs: Record<string, unknown> | null = null;
const agentFsIn = (state: "ready" | "disconnected") => ({
  state,
  client: state === "ready" ? fakeClient : null,
  endpoint: "https://fs.test",
  liveUrl: null,
  credential: state === "ready" ? { userId: "u1" } : null,
  liveDriveId: null,
});

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// this component's graph maps to its real file. The agent-fs context and the
// link-chip origins (whose graphs need the whole app) are stubs; the media URL
// hook is the real one, run against the fake client.
mock.module("@/contexts/agent-fs-context", () => ({
  useAgentFs: () => agentFs,
  useOptionalAgentFs: () => agentFs,
}));
mock.module("../markdown-link-chip", () => ({
  useSwarmLinkOrigins: () => ({
    dashboard: window.location.origin,
    configuredDashboard: null,
    agentFsLive: null,
    agentFsApi: null,
    github: null,
  }),
}));
mock.module("@/api/client", () => ({ api: {} }));
for (const [alias, path] of [
  ["@/lib/utils", "../../../lib/utils"],
  ["@/lib/approval-format", "../../../lib/approval-format"],
  ["@/lib/link-preview", "../../../lib/link-preview"],
  ["@/lib/markdown-images", "../../../lib/markdown-images"],
  ["@/lib/agent-fs/client", "../../../lib/agent-fs/client"],
  ["@/lib/agent-fs/invalidation", "../../../lib/agent-fs/invalidation"],
  ["@/lib/agent-fs/query", "../../../lib/agent-fs/query"],
  ["@/lib/comb/bulk", "../../../lib/comb/bulk"],
  ["@/lib/comb/comments", "../../../lib/comb/comments"],
  ["@/lib/comb/copy-contents", "../../../lib/comb/copy-contents"],
  ["@/lib/comb/html-view", "../../../lib/comb/html-view"],
  ["@/lib/comb/media", "../../../lib/comb/media"],
  ["@/lib/comb/mentions", "../../../lib/comb/mentions"],
  ["@/lib/comb/recent", "../../../lib/comb/recent"],
  ["@/lib/comb/search", "../../../lib/comb/search"],
  ["@/lib/comb/text-content", "../../../lib/comb/text-content"],
  ["@/hooks/use-object-url", "../../../hooks/use-object-url"],
  ["@/api/hooks/use-agent-fs", "../../../api/hooks/use-agent-fs"],
  ["@/components/ui/badge", "../../ui/badge"],
  ["@/components/ui/tooltip", "../../ui/tooltip"],
  ["@/components/shared/animated-reveal", "../animated-reveal"],
  ["@/components/shared/border-beam", "../border-beam"],
  ["@/components/shared/setup-chip", "../setup-chip"],
  ["@/components/shared/status-icon", "../status-icon"],
  ["@/components/shared/markdown-image", "../markdown-image"],
] as const) {
  mock.module(alias, () => require(path));
}

const { QuestionCard } = await import("./question-card");
const { TooltipProvider } = await import("../../ui/tooltip");

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

let unmount: (() => Promise<void>) | null = null;

/** Renders one approval question whose description is `description`. */
async function renderDescription(description: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // retryDelay 0: a 5xx retries (agentFsRetry) without waiting out the backoff.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <QuestionCard
            question={{ id: "q1", type: "approval", label: "Ship it?", description }}
            index={0}
            statusTone="pending"
            statusLabel="Waiting"
            focused={false}
            beam={false}
            collapsed={null}
            onToggleCollapsed={() => {}}
            answer={undefined}
            hint={null}
            onActivate={() => {}}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
    queryClient.clear();
  };
  await settle();
  return container;
}

/** Settles until `check` holds or the tries run out (react-query resolves over several ticks). */
async function until(check: () => boolean) {
  for (let i = 0; i < 20 && !check(); i++) await settle();
}

const DRIVE_FILE = (path: string) => `${DASHBOARD}/file/~/org-1/drive-1${path}`;
const media = (root: HTMLElement) => root.querySelector("[data-markdown-image]");

beforeEach(() => {
  agentFs = null;
  calls.length = 0;
  for (const key of Object.keys(stats)) delete stats[key];
  for (const key of Object.keys(statErrors)) delete statErrors[key];
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
});

describe("QuestionCard description media", () => {
  test("a bare video URL plays inline, with an open link", async () => {
    const root = await renderDescription("Watch https://cdn.test/run/demo.mp4 first.");
    const video = root.querySelector("video");
    expect(video?.getAttribute("src")).toBe("https://cdn.test/run/demo.mp4");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(media(root)?.getAttribute("data-markdown-image")).toBe("video");
  });

  test("an extensionless share link labelled demo.mp4 plays inline", async () => {
    const share = "https://fs.test/share/t1/raw";
    const root = await renderDescription(`Clip: [demo.mp4](${share})`);
    expect(root.querySelector("video")?.getAttribute("src")).toBe(share);
    const open = root.querySelector('[data-markdown-image="video"] a');
    expect(open?.getAttribute("href")).toBe(share);
    expect(open?.textContent).toBe("demo.mp4");
  });

  test("a connected drive file link loads through the drive's presigned URL", async () => {
    agentFs = agentFsIn("ready");
    stats["/media/clip.mp4"] = {
      path: "/media/clip.mp4",
      size: 10,
      contentType: "video/mp4",
      author: "a",
      createdAt: "2026-01-01T00:00:00Z",
      modifiedAt: "2026-01-01T00:00:00Z",
      isDeleted: false,
    };
    const root = await renderDescription(`Demo: [clip.mp4](${DRIVE_FILE("/media/clip.mp4")})`);
    await until(() => root.querySelector("video") !== null);
    expect(root.querySelector("video")?.getAttribute("src")).toBe(
      "https://bucket.test/media/clip.mp4?sig=1",
    );
    // "Open" still goes to the link as written, not to the expiring URL.
    expect(root.querySelector('[data-markdown-image="video"] a')?.getAttribute("href")).toBe(
      DRIVE_FILE("/media/clip.mp4"),
    );
    expect(calls).toEqual(["stat /media/clip.mp4", "signed-url /media/clip.mp4"]);
  });

  test("a drive file link without a connected drive stays a plain link", async () => {
    for (const value of [null, agentFsIn("disconnected")]) {
      agentFs = value;
      const href = DRIVE_FILE("/media/shot.jpg");
      const root = await renderDescription(`See [shot.jpg](${href})`);
      expect(media(root)).toBeNull();
      expect(root.querySelector("img, video")).toBeNull();
      const link = root.querySelector(`a[href="${href}"]`);
      expect(link?.textContent).toBe("shot.jpg");
      expect(calls).toEqual([]);
      await unmount?.();
      unmount = null;
    }
  });

  for (const [status, code] of [
    [404, "NOT_FOUND"],
    [403, "FORBIDDEN"],
    [500, "INTERNAL"],
  ] as const) {
    test(`a drive file whose stat fails (${status}) falls back to the link, not a skeleton`, async () => {
      agentFs = agentFsIn("ready");
      const href = DRIVE_FILE("/media/missing.jpg");
      statErrors["/media/missing.jpg"] = new AgentFsError(status, code, `stat ${status}`);
      const root = await renderDescription(`See [missing.jpg](${href})`);
      await until(() => media(root)?.getAttribute("data-markdown-image") !== "loading");
      expect(media(root)).toBeNull();
      const link = root.querySelector(`a[href="${href}"]`);
      expect(link?.textContent).toBe("missing.jpg");
      // The URL queries wait on stat, so a failed stat never mints one.
      expect(calls.filter((call) => call.startsWith("signed-url"))).toEqual([]);
    });
  }
});
