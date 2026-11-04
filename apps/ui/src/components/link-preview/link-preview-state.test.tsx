import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useState } from "react";
import type { TaskAttachment } from "../../api/types";
import type { AgentFsLinkContext } from "../shared/task-attachment-link";

// A real DOM: these tests click the rendered links. The dashboard origin must
// be a real one, so root-relative links resolve.
GlobalRegistrator.register({ url: "https://swarm.test/tasks/task-1" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The root test run cannot resolve the UI's `@/` alias. The link, preview and
// panel state modules map to their real files, so the whole click path runs:
// chip or attachment row, `useLinkPreviewClick`, the context panel state.
const SRC = new URL("../../", import.meta.url).pathname;
for (const alias of [
  "@/components/context-panel/context-panel-state",
  "@/components/link-preview/link-preview-state",
  "@/components/shared/markdown-link-chip",
  "@/components/shared/in-app-or-external-link",
  "@/components/shared/task-attachment-link",
  "@/components/shared/animated-reveal",
  "@/components/shared/collapsible-section",
  "@/components/shared/copy-value-button",
  "@/components/kibo-ui/spinner",
  "@/components/ui/spinner",
  "@/components/ui/alert-dialog",
  "@/components/ui/badge",
  "@/components/ui/button",
  "@/components/ui/dialog",
  "@/components/ui/middle-truncation",
  "@/hooks/use-copy-to-clipboard",
  "@/hooks/use-comb-links",
  "@/lib/comb/links",
  "@/lib/format-bytes",
  "@/lib/link-preview",
  "@/lib/scrub-secrets",
  "@/lib/short-id",
  "@/lib/swarm-links",
  "@/lib/task-title",
  "@/lib/utils",
]) {
  const path = Bun.resolveSync(`./${alias.slice(2)}`, SRC);
  mock.module(alias, () => require(path));
}

let agentFs: AgentFsLinkContext | null = null;
mock.module("@/contexts/agent-fs-context", () => ({ useOptionalAgentFs: () => agentFs }));
mock.module("@/api/client", () => ({ api: {} }));
mock.module("@/api/fs", () => ({
  fetchTaskAttachmentBlob: async () => new Blob(),
  useDeleteAttachment: () => ({ mutate: () => {}, isPending: false, variables: undefined }),
  useTaskAttachments: () => ({ data: undefined }),
}));
mock.module("@/app/status-context", () => ({ useOptionalStatusContext: () => null }));
mock.module("@/api/hooks/use-feature-gate", () => ({
  useFeatureGate: () => ({ supported: true }),
}));
mock.module("@/hooks/use-local-toggle", () => ({
  useLocalToggle: (_key: string, initial: boolean) => useState(initial),
}));
mock.module("@/components/comb/file-icon", () => ({ FileKindIcon: () => null }));
// The scope renders the preview sheet; its body (fetches, frames) is out of scope here.
mock.module("./link-preview-panel", () => ({
  LinkPreviewSheet: () => <div data-testid="preview-sheet" />,
  LinkPreviewContent: () => null,
}));
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { ContextPanelProvider, useContextPanel } = await import(
  "../context-panel/context-panel-state"
);
const { LinkPreviewScope } = await import("./link-preview-state");
const { SwarmLinkView } = await import("../shared/markdown-link-chip");
const { TaskAttachmentsSection } = await import("../shared/task-attachments-section");
const { parseSwarmLink } = await import("../../lib/swarm-links");

const ORIGIN = "https://swarm.test";
const LIVE = "https://fs.test";
const PAGE_ID = "cfd9bc4bc838487ea7cde4708dfb4dc1";
const COMB_READY: AgentFsLinkContext = {
  state: "ready",
  endpoint: "https://afs-api.test",
  orgId: "org-1",
  driveId: "drive-1",
  liveUrl: LIVE,
};

/** The router path and the context panel state, for the assertions. */
function Probe() {
  const { pathname, search } = useLocation();
  const panel = useContextPanel();
  return (
    <div>
      <output data-testid="location">{`${pathname}${search}`}</output>
      <output data-testid="preview">{JSON.stringify(panel.preview)}</output>
      <output data-testid="session-open">{String(panel.open)}</output>
      <button type="button" data-testid="open-session" onClick={() => panel.setOpen(true)} />
    </div>
  );
}

function Chip({ href }: { href: string }) {
  const link = parseSwarmLink(href, {
    dashboard: ORIGIN,
    configuredDashboard: null,
    agentFsLive: agentFs?.liveUrl ?? null,
    agentFsApi: null,
  });
  if (!link) throw new Error(`not a swarm link: ${href}`);
  return <SwarmLinkView link={link} label="the link" />;
}

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

async function render(content: ReactNode, { scoped = true } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const page = scoped ? <LinkPreviewScope>{content}</LinkPreviewScope> : content;
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/tasks/task-1"]}>
          <ContextPanelProvider>
            <Probe />
            <Routes>
              <Route path="/tasks/:id" element={page} />
              <Route path="*" element={<p>left the task page</p>} />
            </Routes>
          </ContextPanelProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
}

const text = (testId: string) =>
  document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
const preview = () => JSON.parse(text("preview") || "null");
function linkNamed(name: string): HTMLAnchorElement {
  const link = [...document.querySelectorAll("a")].find((a) => a.textContent === name);
  if (!link) throw new Error(`no link named ${name}`);
  return link;
}
async function click(el: HTMLElement, init: MouseEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });
}

beforeEach(() => {
  agentFs = COMB_READY;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("a markdown link chip on the task page", () => {
  test("a plain click on a file link opens the preview and stays on the page", async () => {
    await render(<Chip href={`${LIVE}/file/~/org-1/drive-1/docs/notes.md?comment=c1`} />);
    await click(linkNamed("the link"));

    expect(text("location")).toBe("/tasks/task-1");
    expect(preview()).toMatchObject({
      kind: "file",
      file: { orgId: "org-1", driveId: "drive-1", path: "/docs/notes.md" },
      route: "/file/~/org-1/drive-1/docs/notes.md?comment=c1",
    });
  });

  test("a page link keeps its query, minus the params the page route owns", async () => {
    await render(<Chip href={`/pages/${PAGE_ID}?target=pr-1373&mode=full&apiKey=x`} />);
    await click(linkNamed("the link"));

    expect(text("location")).toBe("/tasks/task-1");
    expect(preview()).toMatchObject({ kind: "page", id: PAGE_ID, query: "?target=pr-1373" });
  });

  test("a modifier click keeps the link's behavior", async () => {
    await render(<Chip href={`/pages/${PAGE_ID}`} />);
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      await click(linkNamed("the link"), { [modifier]: true });
      expect(preview()).toBeNull();
    }
    expect(text("location")).toBe("/tasks/task-1");
  });

  test("a link inside a dialog navigates as usual", async () => {
    await render(
      <div role="dialog">
        <Chip href={`/pages/${PAGE_ID}?target=pr-1373`} />
      </div>,
    );
    await click(linkNamed("the link"));

    expect(preview()).toBeNull();
    expect(text("location")).toBe(`/pages/${PAGE_ID}?target=pr-1373`);
  });

  test("outside a preview scope a link navigates as usual", async () => {
    await render(<Chip href={`/pages/${PAGE_ID}`} />, { scoped: false });
    await click(linkNamed("the link"));

    expect(preview()).toBeNull();
    expect(text("location")).toBe(`/pages/${PAGE_ID}`);
  });

  test("a folder link opens the folder in Comb, not a preview", async () => {
    await render(<Chip href={`${LIVE}/file/~/org-1/drive-1/docs/`} />);
    await click(linkNamed("the link"));

    expect(preview()).toBeNull();
    expect(text("location")).toBe("/file/~/org-1/drive-1/docs/");
  });
});

describe("the right column shows one panel at a time", () => {
  test("a preview closes the session panel, and the session panel closes the preview", async () => {
    await render(<Chip href={`/pages/${PAGE_ID}`} />);
    await click(document.querySelector<HTMLElement>('[data-testid="open-session"]')!);
    expect(text("session-open")).toBe("true");

    await click(linkNamed("the link"));
    expect(preview()).toMatchObject({ kind: "page", id: PAGE_ID });
    expect(text("session-open")).toBe("false");

    await click(document.querySelector<HTMLElement>('[data-testid="open-session"]')!);
    expect(preview()).toBeNull();
    expect(text("session-open")).toBe("true");
  });
});

describe("an attachment row on the task page", () => {
  const file = {
    id: "att-1",
    taskId: "task-1",
    agentId: null,
    kind: "agent-fs",
    name: "notes.md",
    path: "docs/notes.md",
    orgId: "org-1",
    driveId: "drive-1",
    mimeType: "text/markdown",
    isPrimary: false,
    createdAt: "2026-11-04T00:00:00.000Z",
  } satisfies TaskAttachment;

  test("a file opens the preview", async () => {
    await render(<TaskAttachmentsSection taskId="task-1" attachments={[file]} />);
    await click(linkNamed("notes.md"));

    expect(text("location")).toBe("/tasks/task-1");
    expect(preview()).toMatchObject({ kind: "file", route: "/file/~/org-1/drive-1/docs/notes.md" });
  });

  test("with no configured live host, a file still opens the preview", async () => {
    agentFs = { ...COMB_READY, liveUrl: null };
    await render(<TaskAttachmentsSection taskId="task-1" attachments={[file]} />);
    await click(linkNamed("notes.md"));

    expect(text("location")).toBe("/tasks/task-1");
    expect(preview()).toMatchObject({
      kind: "file",
      file: { orgId: "org-1", driveId: "drive-1", path: "/docs/notes.md" },
    });
  });

  test("a page attachment opens the preview", async () => {
    const page = { ...file, id: "att-2", kind: "page", name: "Report", pageId: PAGE_ID };
    await render(<TaskAttachmentsSection taskId="task-1" attachments={[page]} />);
    await click(linkNamed("Report"));

    expect(preview()).toMatchObject({ kind: "page", id: PAGE_ID, query: "" });
  });
});
