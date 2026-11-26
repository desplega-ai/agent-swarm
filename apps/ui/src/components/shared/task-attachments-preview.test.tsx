import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { TaskAttachment } from "../../api/types";

GlobalRegistrator.register();
// happy-dom never loads iframe pages and logs each attempt; the test reads the src only.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (String(args[0]).includes("Iframe page loading is disabled")) return;
  consoleError(...args);
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");

// The raw route's bytes, with the Content-Type the server sent for them.
let rawBlob = new Blob();
mock.module("@/api/fs", () => ({
  fetchTaskAttachmentBlob: async () => rawBlob,
  useDeleteAttachment: () => ({ mutate: () => {}, isPending: false, variables: undefined }),
  useTaskAttachments: () => ({ data: undefined }),
}));
mock.module("@/contexts/agent-fs-context", () => ({ useOptionalAgentFs: () => null }));
mock.module("@/components/link-preview/link-preview-state", () => ({
  useLinkPreviewClick: () => undefined,
}));
mock.module("@/components/shared/markdown-link-chip", () => ({
  useSwarmLinkOrigins: () => ({
    dashboard: "https://swarm.test",
    configuredDashboard: null,
    agentFsLive: null,
    agentFsApi: null,
  }),
  SwarmLinkView: ({ link }: { link: { href: string } }) => (
    <a data-slot="swarm-link" href={link.href}>
      chip
    </a>
  ),
}));
mock.module("@/components/kibo-ui/spinner", () => require("../kibo-ui/spinner"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));
mock.module("@/components/shared/animated-reveal", () => require("./animated-reveal"));
mock.module("@/components/shared/collapsible-section", () => require("./collapsible-section"));
mock.module("@/components/shared/copy-value-button", () => require("./copy-value-button"));
mock.module("@/hooks/use-copy-to-clipboard", () => require("../../hooks/use-copy-to-clipboard"));
mock.module("@/components/ui/alert-dialog", () => require("../ui/alert-dialog"));
mock.module("@/components/shared/in-app-or-external-link", () =>
  require("./in-app-or-external-link"),
);
mock.module("@/components/shared/task-attachment-link", () => require("./task-attachment-link"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/dialog", () => require("../ui/dialog"));
mock.module("@/components/ui/middle-truncation", () => require("../ui/middle-truncation"));
mock.module("@/lib/format-bytes", () => require("../../lib/format-bytes"));
mock.module("@/lib/scrub-secrets", () => require("../../lib/scrub-secrets"));
mock.module("@/lib/swarm-links", () => require("../../lib/swarm-links"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { TaskAttachmentsSection } = await import("./task-attachments-section");

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
let framed: Blob[] = [];

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  framed = [];
  URL.createObjectURL = ((blob: Blob) => {
    framed.push(blob);
    return `blob:https://dashboard.test/${framed.length}`;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
});

afterAll(() => {
  console.error = consoleError;
  GlobalRegistrator.unregister();
});

function attachment(name: string): TaskAttachment {
  return {
    id: "att-1",
    taskId: "task-1",
    kind: "shared-fs",
    providerId: "local-fs",
    name,
    path: `task-1/${name}`,
    mimeType: "application/pdf",
    sizeBytes: 64,
  } as TaskAttachment;
}

async function expandPreview(row: TaskAttachment): Promise<HTMLIFrameElement | null> {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TaskAttachmentsSection taskId="task-1" attachments={[row]} />
      </MemoryRouter>,
    ),
  );
  const toggle = host.querySelector<HTMLButtonElement>(
    `button[aria-label="Show ${row.name} preview"]`,
  );
  expect(toggle).not.toBeNull();
  await act(async () => toggle?.click());
  for (let i = 0; i < 20 && !host.querySelector("iframe"); i++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  return host.querySelector("iframe");
}

describe("PDF attachment preview", () => {
  test("control: a PDF served as a PDF is framed as a PDF", async () => {
    rawBlob = new Blob(["%PDF-1.4 marker"], { type: "application/pdf" });
    const iframe = await expandPreview(attachment("report.pdf"));

    expect(iframe).not.toBeNull();
    expect(framed).toHaveLength(1);
    expect(framed[0]?.type).toBe("application/pdf");
  });

  test("frames the bytes as a PDF whatever type the raw route sent", async () => {
    rawBlob = new Blob(["<p>marker</p>"], { type: "text/html" });
    const iframe = await expandPreview(attachment("report.html"));

    expect(iframe).not.toBeNull();
    expect(framed).toHaveLength(1);
    expect(framed[0]?.type).toBe("application/pdf");
  });
});
