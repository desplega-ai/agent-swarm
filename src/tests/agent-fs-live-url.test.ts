import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAgentFsLiveUrl } from "../utils/constants";

const originalHost = process.env.AGENT_FS_LIVE_URL;

beforeEach(() => {
  process.env.AGENT_FS_LIVE_URL = "https://files.example.test/";
});

afterEach(() => {
  if (originalHost === undefined) delete process.env.AGENT_FS_LIVE_URL;
  else process.env.AGENT_FS_LIVE_URL = originalHost;
});

describe("buildAgentFsLiveUrl path encoding", () => {
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
  ])("%s", (_label, path, expectedPath) => {
    expect(buildAgentFsLiveUrl({ path, orgId: "org-1", driveId: "drive-1" })).toBe(
      `https://files.example.test/file/~/org-1/drive-1/${expectedPath}`,
    );
  });
});

describe("buildAgentFsLiveUrl with AGENT_FS_PUBLIC_URL", () => {
  afterEach(() => {
    delete process.env.AGENT_FS_PUBLIC_URL;
  });

  test("appends ?apiUrl= after the encoded path", () => {
    process.env.AGENT_FS_PUBLIC_URL = "https://api.example.test/agentfs/";
    expect(
      buildAgentFsLiveUrl({ path: "/reports/café #1?.md", orgId: "org-1", driveId: "drive-1" }),
    ).toBe(
      "https://files.example.test/file/~/org-1/drive-1/reports/caf%C3%A9%20%231%3F.md?apiUrl=https%3A%2F%2Fapi.example.test%2Fagentfs",
    );
  });
});
