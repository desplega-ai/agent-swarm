import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AttachmentName, buildAgentFsLiveUrl } from "./task-attachment-link";

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
});
