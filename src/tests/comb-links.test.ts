import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildCitationUrl } from "../be/task-citations";
import type { TaskAttachment } from "../types";
import {
  agentFsFileLinkQuery,
  buildAgentFsLiveUrl,
  readAgentFsLinkTarget,
  resolveAgentFsLinkBase,
} from "../utils/constants";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";

const ENV_KEYS = [
  "COMB_ENABLED",
  "APP_URL",
  "DASHBOARD_URL",
  "AGENT_FS_API_URL",
  "AGENT_FS_LIVE_URL",
  "AGENT_FS_LINK_TARGET",
  "AGENT_FS_DEFAULT_ORG_ID",
  "AGENT_FS_DEFAULT_DRIVE_ID",
  "AGENT_FS_PROXY",
  "AGENT_FS_PUBLIC_URL",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
  process.env.AGENT_FS_LIVE_URL = "https://live.example.test/";
  // Comb is on by default with AGENT_FS_API_URL set. Tests that need it off
  // set COMB_ENABLED=false.
  process.env.COMB_ENABLED = "false";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function agentFsAttachment(overrides: Partial<TaskAttachment> = {}): TaskAttachment {
  return {
    id: "att-1",
    taskId: "task-1",
    kind: "agent-fs",
    name: "notes.md",
    providerId: "agent-fs",
    path: "comb-qa/notes.md",
    orgId: "org-1",
    driveId: "drive-1",
    ...overrides,
  } as TaskAttachment;
}

const LIVE = "https://live.example.test/file/~/org-1/drive-1/comb-qa/notes.md";
const COMB = "http://localhost:5274/file/~/org-1/drive-1/comb-qa/notes.md";

describe("taskAttachmentDisplayUrl for agent-fs attachments", () => {
  test("flag off: the live URL, even with APP_URL set", () => {
    process.env.APP_URL = "http://localhost:5274";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
  });

  test("flag unset: on by default, so the dashboard URL with APP_URL", () => {
    delete process.env.COMB_ENABLED;
    process.env.APP_URL = "http://localhost:5274/";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(COMB);
  });

  test("flag on with APP_URL: the dashboard URL", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274/";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(COMB);
  });

  test("the deprecated DASHBOARD_URL also counts as a configured app URL", () => {
    process.env.COMB_ENABLED = "true";
    process.env.DASHBOARD_URL = "http://localhost:5274";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(COMB);
  });

  test("flag on without APP_URL: the live URL (never the hosted default dashboard)", () => {
    process.env.COMB_ENABLED = "true";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
  });

  test("flag on without an agent-fs API URL: Comb is off, so the live URL", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    delete process.env.AGENT_FS_API_URL;
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
  });

  test("comb: false keeps the live URL", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    expect(taskAttachmentDisplayUrl(agentFsAttachment(), { comb: false })).toBe(LIVE);
  });

  test("row ids override env ids, and a partial row never mixes with them", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    process.env.AGENT_FS_DEFAULT_ORG_ID = "env-org";
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = "env-drive";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(COMB);
    expect(
      taskAttachmentDisplayUrl(agentFsAttachment({ orgId: undefined, driveId: undefined })),
    ).toBe("http://localhost:5274/file/~/env-org/env-drive/comb-qa/notes.md");
    expect(taskAttachmentDisplayUrl(agentFsAttachment({ driveId: undefined }))).toBe(
      "agent-fs:comb-qa/notes.md",
    );
  });

  test("encoding keeps existing %HH escapes and encodes raw text", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    expect(
      taskAttachmentDisplayUrl(
        agentFsAttachment({ path: "/shared%20reports/final report 100%.md" }),
      ),
    ).toBe(
      "http://localhost:5274/file/~/org-1/drive-1/shared%20reports/final%20report%20100%25.md",
    );
    expect(taskAttachmentDisplayUrl(agentFsAttachment({ path: "reports/café #1?.md" }))).toBe(
      "http://localhost:5274/file/~/org-1/drive-1/reports/caf%C3%A9%20%231%3F.md",
    );
  });

  test("other attachment kinds are unchanged", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    expect(
      taskAttachmentDisplayUrl(
        agentFsAttachment({ kind: "url", providerId: undefined, url: "https://example.com/a" }),
      ),
    ).toBe("https://example.com/a");
    expect(
      taskAttachmentDisplayUrl(
        agentFsAttachment({ kind: "page", providerId: undefined, pageId: "page-1" }),
      ),
    ).toBe("http://localhost:5274/pages/page-1");
  });

  test("a dot segment, raw or encoded, falls back to agent-fs:<path>", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    for (const path of ["../../settings", "%2e%2e/%2e%2e/settings", "a/./b.md", "a/.%2E/b.md"]) {
      const file = { path, orgId: "org-1", driveId: "drive-1" };
      expect(buildAgentFsLiveUrl(file)).toBeNull();
      expect(taskAttachmentDisplayUrl(agentFsAttachment({ path }))).toBe(`agent-fs:${path}`);
    }
    // Dots inside a name are not dot segments.
    expect(buildAgentFsLiveUrl({ path: "a/.b/c..md", orgId: "org-1", driveId: "drive-1" })).toBe(
      "https://live.example.test/file/~/org-1/drive-1/a/.b/c..md",
    );
  });
});

describe("live links carry ?apiUrl= for a key-less browser", () => {
  const PUBLIC = "https://fs.example.test";
  const QUERY = `?apiUrl=${encodeURIComponent(PUBLIC)}`;

  test("set AGENT_FS_PUBLIC_URL: live links get the query, dashboard links do not", () => {
    process.env.AGENT_FS_PUBLIC_URL = `${PUBLIC}/`;
    expect(agentFsFileLinkQuery("https://live.example.test")).toBe(QUERY);
    expect(agentFsFileLinkQuery("http://localhost:5274")).toBe("");
    expect(
      buildAgentFsLiveUrl({ path: "comb-qa/notes.md", orgId: "org-1", driveId: "drive-1" }),
    ).toBe(`${LIVE}${QUERY}`);
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(`${LIVE}${QUERY}`);
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(COMB);
    expect(taskAttachmentDisplayUrl(agentFsAttachment(), { comb: false })).toBe(`${LIVE}${QUERY}`);
  });

  test("no AGENT_FS_PUBLIC_URL: live links stay as they are", () => {
    expect(agentFsFileLinkQuery("https://live.example.test")).toBe("");
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
  });
});

describe("agent-fs citations", () => {
  test("store the live URL even with Comb on (the dashboard maps it when it renders)", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    process.env.AGENT_FS_DEFAULT_ORG_ID = "org-1";
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = "drive-1";
    expect(buildCitationUrl({ index: 1, kind: "agent-fs", ref: "comb-qa/notes.md" })).toBe(LIVE);
    // Slack and prompts still link attachments to the dashboard.
    expect(
      taskAttachmentDisplayUrl(agentFsAttachment({ orgId: undefined, driveId: undefined })),
    ).toBe(COMB);
  });
});

describe("AGENT_FS_LINK_TARGET", () => {
  test("unset without APP_URL: live on both surfaces", () => {
    expect(readAgentFsLinkTarget()).toBe("live");
    expect(resolveAgentFsLinkBase("attachment")).toBe("https://live.example.test");
    expect(resolveAgentFsLinkBase("prompt")).toBe("https://live.example.test");
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
  });

  test("unset with APP_URL: the dashboard by default", () => {
    delete process.env.COMB_ENABLED;
    process.env.APP_URL = "http://localhost:5274/";
    expect(readAgentFsLinkTarget()).toBe("dashboard");
    expect(resolveAgentFsLinkBase("prompt")).toBe("http://localhost:5274");
    expect(resolveAgentFsLinkBase("attachment")).toBe("http://localhost:5274");
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(COMB);
    // Attachments still need Comb on.
    delete process.env.AGENT_FS_API_URL;
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
  });

  test("unset with APP_URL and COMB_ENABLED=false: live on both surfaces", () => {
    process.env.APP_URL = "http://localhost:5274/";
    expect(readAgentFsLinkTarget()).toBe("live");
    expect(resolveAgentFsLinkBase("prompt")).toBe("https://live.example.test");
    expect(resolveAgentFsLinkBase("attachment")).toBe("https://live.example.test");
    // On a worker (no AGENT_FS_API_URL) the explicit flag still decides.
    delete process.env.AGENT_FS_API_URL;
    expect(resolveAgentFsLinkBase("prompt")).toBe("https://live.example.test");
    delete process.env.COMB_ENABLED;
    expect(resolveAgentFsLinkBase("prompt")).toBe("http://localhost:5274");
  });

  test("the deprecated DASHBOARD_URL also turns the dashboard default on", () => {
    delete process.env.COMB_ENABLED;
    process.env.DASHBOARD_URL = "http://localhost:5274";
    expect(readAgentFsLinkTarget()).toBe("dashboard");
    expect(resolveAgentFsLinkBase("prompt")).toBe("http://localhost:5274");
  });

  test("live on a Comb + APP_URL install: the live URL", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    process.env.AGENT_FS_LINK_TARGET = " Live ";
    expect(readAgentFsLinkTarget()).toBe("live");
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
    expect(resolveAgentFsLinkBase("prompt")).toBe("https://live.example.test");
  });

  test("dashboard with Comb on and APP_URL: the dashboard URL", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274/";
    process.env.AGENT_FS_LINK_TARGET = "dashboard";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(COMB);
    expect(resolveAgentFsLinkBase("prompt")).toBe("http://localhost:5274");
  });

  test("dashboard with Comb explicitly off: the live URL on both surfaces", () => {
    process.env.APP_URL = "http://localhost:5274";
    process.env.AGENT_FS_LINK_TARGET = "dashboard";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
    expect(resolveAgentFsLinkBase("attachment")).toBe("https://live.example.test");
    expect(resolveAgentFsLinkBase("prompt")).toBe("https://live.example.test");
  });

  test("dashboard with Comb off for lack of agent-fs: the prompt still uses APP_URL", () => {
    // A worker never has AGENT_FS_API_URL, so only an explicit false counts.
    delete process.env.COMB_ENABLED;
    delete process.env.AGENT_FS_API_URL;
    process.env.APP_URL = "http://localhost:5274";
    process.env.AGENT_FS_LINK_TARGET = "dashboard";
    expect(resolveAgentFsLinkBase("attachment")).toBe("https://live.example.test");
    expect(resolveAgentFsLinkBase("prompt")).toBe("http://localhost:5274");
  });

  test("dashboard without APP_URL: the live URL on both surfaces", () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_LINK_TARGET = "dashboard";
    expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(LIVE);
    expect(resolveAgentFsLinkBase("prompt")).toBe("https://live.example.test");
  });

  test("an invalid or blank value counts as unset", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    for (const value of ["Dashboard2", "comb", "", "   "]) {
      process.env.AGENT_FS_LINK_TARGET = value;
      expect(readAgentFsLinkTarget()).toBe("dashboard");
      expect(resolveAgentFsLinkBase("prompt")).toBe("http://localhost:5274");
      expect(taskAttachmentDisplayUrl(agentFsAttachment())).toBe(COMB);
    }
  });

  test("comb: false still links to the live URL", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    process.env.AGENT_FS_LINK_TARGET = "dashboard";
    expect(taskAttachmentDisplayUrl(agentFsAttachment(), { comb: false })).toBe(LIVE);
  });

  test("a bad path still falls back to agent-fs:<path>", () => {
    process.env.COMB_ENABLED = "true";
    process.env.APP_URL = "http://localhost:5274";
    process.env.AGENT_FS_LINK_TARGET = "dashboard";
    expect(taskAttachmentDisplayUrl(agentFsAttachment({ path: "../x" }))).toBe("agent-fs:../x");
    expect(
      taskAttachmentDisplayUrl(agentFsAttachment({ orgId: undefined, driveId: undefined })),
    ).toBe("agent-fs:comb-qa/notes.md");
  });
});
