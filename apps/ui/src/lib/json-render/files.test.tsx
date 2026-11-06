import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useEffect, useState } from "react";
import type { LsResult, StatResult } from "../agent-fs/types";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { AgentFsError } = await import("../agent-fs/client");

/**
 * A fake agent-fs client: `ls` and `stat` answer from these maps, keyed by
 * drive path, and every call is recorded with the drive it targeted.
 */
const folders: Record<string, LsResult> = {};
const stats: Record<string, StatResult> = {};
const texts: Record<string, string> = {};
const calls: { op: string; path: string; orgId: string; driveId?: string }[] = [];
const fakeClient = {
  async callOp(orgId: string, op: string, params: { path: string }, driveId?: string) {
    calls.push({ op, path: params.path, orgId, driveId });
    const table = op === "ls" ? folders : stats;
    const hit = table[params.path];
    if (!hit) throw new AgentFsError(404, "NOT_FOUND", `${params.path} not found`);
    return hit;
  },
};

type AgentFsValue = {
  state: string;
  client: typeof fakeClient | null;
  orgId: string | null;
  driveId: string | null;
  error: null;
  retry: () => void;
};
let agentFs: AgentFsValue | null = null;
const ready = (): AgentFsValue => ({
  state: "ready",
  client: fakeClient,
  orgId: "org-1",
  driveId: "drive-1",
  error: null,
  retry: () => {},
});

// The test runner cannot resolve ui's `@/` alias, so each aliased module is
// mapped to its real file or a stub. The hooks call the fake client the way
// `use-agent-fs.ts` does: `callOp(org, op, { path }, drive)`.
function useFakeOp<T>(op: string, target: { orgId: string; driveId: string; path: string }) {
  const [result, setResult] = useState<{ data?: T; error?: Error }>({});
  useEffect(() => {
    let live = true;
    setResult({});
    fakeClient.callOp(target.orgId, op, { path: target.path }, target.driveId).then(
      (data) => live && setResult({ data: data as T }),
      (error: Error) => live && setResult({ error }),
    );
    return () => {
      live = false;
    };
  }, [op, target.orgId, target.driveId, target.path]);
  return result;
}
mock.module("@/api/hooks/use-agent-fs", () => ({
  useAgentFsLs: (target: { orgId: string; driveId: string; path: string }) =>
    useFakeOp<LsResult>("ls", target),
  useAgentFsStat: (target: { orgId: string; driveId: string; path: string }) =>
    useFakeOp<StatResult>("stat", target),
  isAccessDenied: (error: unknown) =>
    error instanceof AgentFsError && (error.status === 401 || error.status === 403),
}));
mock.module("@/contexts/agent-fs-context", () => ({ useOptionalAgentFs: () => agentFs }));
mock.module("@/components/comb/connect-card", () => ({
  ConnectCard: () => <div data-testid="connect-card" />,
}));
mock.module("@/components/comb/file-actions", () => ({
  DownloadButton: () => <button type="button">Download</button>,
  OpenInAgentFsButton: () => <a href="https://live.example/x">Open in agent-fs</a>,
}));
mock.module("@/components/comb/file-icon", () => ({ FileKindIcon: () => <span /> }));
const viewer =
  (kind: string) =>
  ({ file }: { file: { path: string } }) =>
    kind === "image" ? (
      <img data-testid="viewer-image" alt="" src={`blob:${file.path}`} />
    ) : (
      <div data-testid={`viewer-${kind}`}>{file.path}</div>
    );
mock.module("@/components/comb/viewers/file-viewer", () => ({
  VIEWERS: Object.fromEntries(
    ["text", "image", "video", "audio", "pdf", "table", "fallback"].map((kind) => [
      kind,
      viewer(kind),
    ]),
  ),
}));
mock.module("@/components/comb/viewers/text-gate", () => ({
  TextGate: ({
    file,
    children,
  }: {
    file: { path: string };
    children: (text: string) => ReactNode;
  }) => children(texts[file.path] ?? ""),
}));
mock.module("@/components/comb/viewers/viewer-skeleton", () => ({
  ViewerSkeleton: () => <div data-testid="skeleton" />,
}));
mock.module("@/components/shared/empty-state", () => ({
  EmptyState: ({ title, action }: { title: string; action?: ReactNode }) => (
    <div data-testid="empty-state">
      <p>{title}</p>
      {action}
    </div>
  ),
}));
mock.module("@/components/shared/markdown-view", () => ({
  MarkdownView: ({ text, html }: { text: string; html?: boolean }) => (
    <div data-testid="markdown" data-html={String(html)}>
      {text}
    </div>
  ),
}));
mock.module("@/components/ui/alert-callout", () => require("../../components/ui/alert-callout"));
mock.module("@/components/ui/button", () => require("../../components/ui/button"));
mock.module("@/components/ui/card", () => require("../../components/ui/card"));
mock.module("@/components/ui/dialog", () => require("../../components/ui/dialog"));
mock.module("@/lib/agent-fs/client", () => require("../agent-fs/client"));
mock.module("@/lib/comb/file-kinds", () => require("../comb/file-kinds"));
mock.module("@/lib/format-bytes", () => require("../format-bytes"));
mock.module("@/lib/utils", () => require("../utils"));

const { FilesView, FileView } = await import("./files");
type FilesProps = Parameters<typeof FilesView>[0]["props"];
type FileRow = Parameters<Parameters<typeof FilesView>[0]["onSelect"]>[0];

function stat(path: string, size = 10): StatResult {
  return { path, size, author: "a", createdAt: "", modifiedAt: "", isDeleted: false };
}

beforeEach(() => {
  document.body.innerHTML = "";
  agentFs = ready();
  calls.length = 0;
  for (const table of [folders, stats, texts]) {
    for (const key of Object.keys(table)) delete table[key];
  }
  folders["/apps/docs/"] = {
    entries: [
      { name: "b.md", type: "file", size: 120, modifiedAt: "2026-11-01T10:00:00Z" },
      { name: "guides", type: "directory", size: 0 },
      { name: "a.png", type: "file", size: 2048 },
    ],
  };
  folders["/apps/docs/guides/"] = { entries: [{ name: "setup.md", type: "file", size: 9 }] };
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function mount(node: ReactNode, url = "/apps/x") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[url]}>{node}</MemoryRouter>);
  });
  await flush();
  return host;
}

async function mountFiles(props: Partial<FilesProps> = {}) {
  const selected: FileRow[] = [];
  const host = await mount(
    <FilesView
      props={{ path: "/apps/docs", ...props } as FilesProps}
      onSelect={(row) => selected.push(row)}
    />,
  );
  return { host, selected };
}

const rowNames = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-testid="app-files-row"]')].map((row) =>
    row.textContent?.replace(/\d.*$/, ""),
  );

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush();
}

describe("Files", () => {
  test("lists the folder from the swarm drive, folders first", async () => {
    const { host } = await mountFiles();
    expect(rowNames(host)).toEqual(["guides", "a.png", "b.md"]);
    expect(calls).toEqual([{ op: "ls", path: "/apps/docs/", orgId: "org-1", driveId: "drive-1" }]);
  });

  test("a file click runs onSelect with the entry as $row", async () => {
    const { host, selected } = await mountFiles();
    const rows = host.querySelectorAll('[data-testid="app-files-row"]');
    await click(rows[2]);
    expect(selected).toEqual([
      {
        path: "/apps/docs/b.md",
        name: "b.md",
        type: "file",
        size: 120,
        modifiedAt: "2026-11-01T10:00:00Z",
      },
    ]);
  });

  test("browser mode descends into a folder and crumbs lead back", async () => {
    const { host, selected } = await mountFiles({ mode: "browser" });
    await click(host.querySelector('[data-testid="app-files-row"]'));
    expect(selected).toEqual([]);
    expect(rowNames(host)).toEqual(["setup.md"]);
    const crumb = [...host.querySelectorAll("nav button")].find((b) => b.textContent === "docs");
    await click(crumb);
    expect(rowNames(host)).toEqual(["guides", "a.png", "b.md"]);
    expect(host.querySelector("nav")).toBeNull();
  });

  test("list mode selects a folder instead of opening it", async () => {
    const { host, selected } = await mountFiles();
    await click(host.querySelector('[data-testid="app-files-row"]'));
    expect(selected.map((row) => row.path)).toEqual(["/apps/docs/guides/"]);
  });

  test("browser mode opens on the folder that holds selectedPath", async () => {
    const { host } = await mountFiles({
      mode: "browser",
      selectedPath: "/apps/docs/guides/setup.md",
    });
    expect(rowNames(host)).toEqual(["setup.md"]);
    const current = host.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain("setup.md");
  });

  test("a missing folder shows the empty message", async () => {
    const { host } = await mountFiles({ path: "/apps/none", emptyMessage: "No docs yet" });
    expect(host.textContent).toContain("No docs yet");
  });

  test("not connected: the connect card, and no agent-fs call", async () => {
    agentFs = { ...ready(), state: "needs-connect", client: null };
    const { host } = await mountFiles();
    expect(host.textContent).toContain("Connect agent-fs to see these files");
    expect(calls).toEqual([]);
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Connect agent-fs",
    );
    await click(button);
    expect(document.querySelector('[data-testid="connect-card"]')).not.toBeNull();
  });

  test("not connected inside a chromeless iframe: link to the dashboard", async () => {
    agentFs = { ...ready(), state: "needs-connect", client: null };
    const top = window.top;
    Object.defineProperty(window, "top", { value: {}, configurable: true });
    try {
      const host = await mount(
        <FilesView props={{ path: "/apps/docs" } as FilesProps} onSelect={() => {}} />,
        "/apps/x?mode=chromeless",
      );
      expect(host.textContent).toContain("Open in dashboard");
      const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent);
      expect(buttons).not.toContain("Connect agent-fs");
    } finally {
      Object.defineProperty(window, "top", { value: top, configurable: true });
    }
  });

  test("a relative path never reaches agent-fs", async () => {
    const { host } = await mountFiles({ path: "apps/docs" });
    expect(host.textContent).toContain("Not an agent-fs folder path");
    expect(calls).toEqual([]);
  });
});

describe("File", () => {
  test("renders Markdown through MarkdownView with raw HTML off", async () => {
    stats["/apps/docs/b.md"] = stat("/apps/docs/b.md");
    texts["/apps/docs/b.md"] = "# Hello <script>x</script>";
    const host = await mount(<FileView props={{ path: "/apps/docs/b.md" }} />);
    const markdown = host.querySelector('[data-testid="markdown"]');
    expect(markdown?.textContent).toBe("# Hello <script>x</script>");
    expect(markdown?.getAttribute("data-html")).toBe("false");
  });

  test("renders an image through the image viewer", async () => {
    stats["/apps/docs/a.png"] = stat("/apps/docs/a.png");
    const host = await mount(<FileView props={{ path: "/apps/docs/a.png" }} />);
    expect(host.querySelector('[data-testid="viewer-image"]')).not.toBeNull();
  });

  test.each([
    ["/apps/docs/page.html", "viewer-text"],
    ["/apps/docs/logo.svg", "viewer-image"],
    ["/apps/docs/report.pdf", "viewer-pdf"],
    ["/apps/docs/archive.zip", "viewer-fallback"],
  ])("routes %s to %s", async (path, testId) => {
    stats[path] = stat(path);
    const host = await mount(<FileView props={{ path }} />);
    expect(host.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
  });

  test("an empty path shows the no-file state without a call", async () => {
    const host = await mount(<FileView props={{ path: "" }} />);
    expect(host.textContent).toContain("No file selected");
    expect(calls).toEqual([]);
  });

  test("a missing file shows not found", async () => {
    const host = await mount(<FileView props={{ path: "/apps/docs/gone.md" }} />);
    expect(host.textContent).toContain("File not found");
  });

  test("not connected: the connect card", async () => {
    agentFs = { ...ready(), state: "invalid-key", client: null };
    const host = await mount(<FileView props={{ path: "/apps/docs/b.md" }} />);
    expect(host.textContent).toContain("agent-fs rejected your saved key");
    expect(calls).toEqual([]);
  });

  test("agent-fs off on this swarm", async () => {
    agentFs = null;
    const host = await mount(<FileView props={{ path: "/apps/docs/b.md" }} />);
    expect(host.textContent).toContain("agent-fs is not set up on this swarm");
  });
});
