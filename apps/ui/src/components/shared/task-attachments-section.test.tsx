import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { TaskAttachment } from "../../api/types";
import {
  type AgentFsLinkContext,
  AttachmentName,
  agentFsAttachmentLinks,
  buildAgentFsLiveUrl,
} from "./task-attachment-link";

// The test runner cannot resolve ui's `@/` alias (see swarm-switcher.test.tsx),
// so each aliased module in the section's graph maps to its real file or a stub.
let agentFs: AgentFsLinkContext | null = null;
mock.module("@/api/fs", () => ({
  fetchTaskAttachmentBlob: async () => new Blob(),
  useDeleteAttachment: () => ({ mutate: () => {}, isPending: false, variables: undefined }),
  useTaskAttachments: () => ({ data: undefined }),
}));
mock.module("@/contexts/agent-fs-context", () => ({ useOptionalAgentFs: () => agentFs }));
mock.module("@/components/kibo-ui/spinner", () => require("../kibo-ui/spinner"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));
mock.module("@/components/shared/animated-reveal", () => require("./animated-reveal"));
mock.module("@/components/shared/collapsible-section", () => require("./collapsible-section"));
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
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { TaskAttachmentsSection, TaskPromptAttachments } = await import(
  "./task-attachments-section"
);

describe("task attachment links", () => {
  test.each([
    ["plain ASCII positive control", "/reports/report-2026_v1.txt", "reports/report-2026_v1.txt"],
    [
      "spaces in every segment",
      "/shared reports/final report.md",
      "shared%20reports/final%20report.md",
    ],
    ["Unicode and URL syntax", "/reports/café #1?.md", "reports/caf%C3%A9%20%231%3F.md"],
    [
      "already encoded positive control",
      "/reports/final%20report%2f%2520.md",
      "reports/final%20report%2f%2520.md",
    ],
    [
      "mixed raw and encoded text",
      "/shared%20reports/final%20report 100%.md",
      "shared%20reports/final%20report%20100%25.md",
    ],
    ["malformed percent escapes", "/reports/100% %2 %GG.md", "reports/100%25%20%252%20%25GG.md"],
  ])("encodes attachment paths: %s", (_label, path, expectedPath) => {
    const href = buildAgentFsLiveUrl({ path, orgId: "org-1", driveId: "drive-1" });
    const html = renderToStaticMarkup(<AttachmentName href={href} name="Report" />);

    expect(href).toBe(`https://live.agent-fs.dev/file/~/org-1/drive-1/${expectedPath}`);
    expect(html).toContain(`href="${href}"`);
  });

  test("renders an agent-fs attachment name as an inline live-host link", () => {
    const href = buildAgentFsLiveUrl({
      path: "thoughts/report.md",
      orgId: "org-1",
      driveId: "drive-1",
    });
    const html = renderToStaticMarkup(<AttachmentName href={href} name="Report" />);

    expect(html).toContain(
      'href="https://live.agent-fs.dev/file/~/org-1/drive-1/thoughts/report.md"',
    );
    expect(html).toContain(">Report</a>");
  });

  test("keeps the name as plain text when the agent-fs drive id is missing", () => {
    const href = buildAgentFsLiveUrl({ path: "thoughts/report.md", orgId: "org-1" });
    const html = renderToStaticMarkup(<AttachmentName href={href} name="Report" />);

    expect(href).toBeNull();
    expect(html).toBe('<span class="truncate text-sm font-medium text-foreground">Report</span>');
  });

  test("keeps partial agent-fs rows as plain text even when default IDs are configured", () => {
    const previousOrgId = process.env.VITE_AGENT_FS_DEFAULT_ORG_ID;
    const previousDriveId = process.env.VITE_AGENT_FS_DEFAULT_DRIVE_ID;
    process.env.VITE_AGENT_FS_DEFAULT_ORG_ID = "default-org";
    process.env.VITE_AGENT_FS_DEFAULT_DRIVE_ID = "default-drive";

    try {
      for (const attachment of [
        { path: "thoughts/report.md", orgId: "org-1" },
        { path: "thoughts/report.md", driveId: "drive-1" },
      ]) {
        const href = buildAgentFsLiveUrl(attachment);
        const html = renderToStaticMarkup(<AttachmentName href={href} name="Report" />);

        expect(href).toBeNull();
        expect(html).toBe(
          '<span class="truncate text-sm font-medium text-foreground">Report</span>',
        );
      }
    } finally {
      if (previousOrgId === undefined) delete process.env.VITE_AGENT_FS_DEFAULT_ORG_ID;
      else process.env.VITE_AGENT_FS_DEFAULT_ORG_ID = previousOrgId;
      if (previousDriveId === undefined) delete process.env.VITE_AGENT_FS_DEFAULT_DRIVE_ID;
      else process.env.VITE_AGENT_FS_DEFAULT_DRIVE_ID = previousDriveId;
    }
  });

  test("uses the server live URL and the swarm drive for rows without ids", () => {
    const drive = {
      liveUrl: "https://files.example.test/",
      defaultOrgId: "swarm-org",
      defaultDriveId: "swarm-drive",
    };
    expect(
      buildAgentFsLiveUrl({ path: "a b.md", orgId: "org-1", driveId: "drive-1", ...drive }),
    ).toBe("https://files.example.test/file/~/org-1/drive-1/a%20b.md");
    expect(buildAgentFsLiveUrl({ path: "a b.md", ...drive })).toBe(
      "https://files.example.test/file/~/swarm-org/swarm-drive/a%20b.md",
    );
    expect(buildAgentFsLiveUrl({ path: "a b.md", orgId: "org-1", ...drive })).toBeNull();
  });

  test("renders an in-app route as a same-tab link", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AttachmentName
          href="https://live.agent-fs.dev/file/~/org-1/drive-1/report.md"
          to="/file/~/org-1/drive-1/report.md"
          name="Report"
        />
      </MemoryRouter>,
    );

    expect(html).toContain('href="/file/~/org-1/drive-1/report.md"');
    expect(html).not.toContain("target=");
  });

  test("a path with a dot segment has no link", () => {
    for (const path of ["../../settings", "%2e%2e/%2e%2e/settings", "a/./b.md"]) {
      expect(buildAgentFsLiveUrl({ path, orgId: "org-1", driveId: "drive-1" })).toBeNull();
    }
  });
});

const LIVE = "https://live.agent-fs.dev";
const COMB_OFF: AgentFsLinkContext = {
  state: "disabled",
  endpoint: null,
  orgId: "swarm-org",
  driveId: "swarm-drive",
  liveUrl: LIVE,
};
const COMB_READY: AgentFsLinkContext = { ...COMB_OFF, state: "ready", endpoint: "http://afs.test" };
/** An uploaded file: the upload route stores no org or drive id. */
const ID_LESS = {
  id: "att-1",
  taskId: "task-1",
  kind: "agent-fs",
  providerId: "agent-fs",
  name: "notes.md",
  path: "comb-qa/notes.md",
  mimeType: "text/markdown",
} as TaskAttachment;
const SWARM_LIVE = `${LIVE}/file/~/swarm-org/swarm-drive/comb-qa/notes.md`;
const SWARM_COMB = "/file/~/swarm-org/swarm-drive/comb-qa/notes.md";

function render(node: ReactNode): string {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("an attachment row without org/drive ids", () => {
  test("uses the swarm drive only while Comb is on", () => {
    expect(agentFsAttachmentLinks(ID_LESS, null)).toEqual({ href: null, combTo: null });
    expect(agentFsAttachmentLinks(ID_LESS, COMB_OFF)).toEqual({ href: null, combTo: null });
    expect(agentFsAttachmentLinks(ID_LESS, { ...COMB_READY, state: "needs-connect" })).toEqual({
      href: SWARM_LIVE,
      combTo: null,
    });
    expect(agentFsAttachmentLinks(ID_LESS, COMB_READY)).toEqual({
      href: SWARM_LIVE,
      combTo: SWARM_COMB,
    });
  });

  test("Comb off: the prompt pill keeps its in-dashboard preview, as before Comb", () => {
    agentFs = COMB_OFF;
    const html = render(<TaskPromptAttachments taskId="task-1" attachments={[ID_LESS]} />);

    expect(html).toContain('aria-label="Expand notes.md preview"');
    expect(html).not.toContain("<a ");
  });

  test("Comb off: the card name stays plain text and has no Open button", () => {
    agentFs = COMB_OFF;
    const html = render(<TaskAttachmentsSection taskId="task-1" attachments={[ID_LESS]} />);

    expect(html).toContain(
      '<span class="truncate text-sm font-medium text-foreground">notes.md</span>',
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Open notes.md");
  });

  test("Comb connected: the pill and the card name open Comb, live stays a secondary action", () => {
    agentFs = COMB_READY;
    const prompt = render(<TaskPromptAttachments taskId="task-1" attachments={[ID_LESS]} />);
    const card = render(<TaskAttachmentsSection taskId="task-1" attachments={[ID_LESS]} />);

    for (const html of [prompt, card]) {
      expect(html).toContain(`href="${SWARM_COMB}"`);
      expect(html).toContain(`href="${SWARM_LIVE}"`);
      expect(html).toContain('aria-label="Open notes.md in agent-fs"');
    }
    expect(prompt).not.toContain("Expand notes.md preview");
  });
});
