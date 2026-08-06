import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentName, buildAgentFsLiveUrl } from "./task-attachment-link";

describe("task attachment links", () => {
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
});
