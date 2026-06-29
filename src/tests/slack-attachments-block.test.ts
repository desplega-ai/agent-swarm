import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildCompletedBlocks, formatAttachmentsBlockForSlack } from "../slack/blocks";
import type { TaskAttachment } from "../types";

// Slack block types are open unions — the builder returns `any`; we read it
// as `any` in the test to inspect the runtime shape.
type SlackBlock = any;

function mkAttachment(overrides: Partial<TaskAttachment>): TaskAttachment {
  return {
    id: crypto.randomUUID(),
    taskId: "00000000-0000-0000-0000-000000000000",
    agentId: null,
    name: overrides.name ?? "attachment.txt",
    kind: overrides.kind ?? "url",
    isPrimary: overrides.isPrimary ?? false,
    createdAt: "2026-05-22T00:00:00.000Z",
    ...overrides,
  };
}

function sectionTexts(blocks: SlackBlock[]): string[] {
  return blocks
    .filter((b: SlackBlock) => b.type === "section")
    .map((b: SlackBlock) => b.text?.text ?? "");
}

describe("formatAttachmentsBlockForSlack", () => {
  test("returns empty string when there are no attachments", () => {
    expect(formatAttachmentsBlockForSlack([])).toBe("");
  });

  test("renders url kind as a plain URL (no mrkdwn link shortcut)", () => {
    const out = formatAttachmentsBlockForSlack([
      mkAttachment({ kind: "url", name: "report", url: "https://example.com/r.pdf" }),
    ]);
    expect(out).toContain("• *report*");
    expect(out).toContain("https://example.com/r.pdf");
    // Crucially: NOT the mrkdwn `<url|label>` shortcut — that triggers
    // `invalid_blocks` in some Slack configurations and the spec mandates
    // plain URLs so Slack auto-unfurls them.
    expect(out).not.toContain("<https://example.com");
  });

  test("uses intent in italics; falls back to description; omits both when absent", () => {
    const intent = mkAttachment({ kind: "url", url: "u1", intent: "primary deliverable" });
    const desc = mkAttachment({ kind: "url", url: "u2", description: "supporting" });
    const neither = mkAttachment({ kind: "url", url: "u3" });
    const out = formatAttachmentsBlockForSlack([intent, desc, neither]);
    expect(out).toContain("_primary deliverable_");
    expect(out).toContain("_supporting_");
    // Neither — only one " — " separator between name and url.
    const neitherLine = out.split("\n").find((l) => l.includes("u3") && l.startsWith("•"));
    expect(neitherLine).toBeDefined();
    expect(neitherLine).not.toContain("__");
  });

  test("page kind resolves via APP_URL", () => {
    const origAppUrl = process.env.APP_URL;
    process.env.APP_URL = "https://app.example.test";
    try {
      const out = formatAttachmentsBlockForSlack([
        mkAttachment({ kind: "page", pageId: "abc123" }),
      ]);
      expect(out).toContain("https://app.example.test/pages/abc123");
    } finally {
      if (origAppUrl === undefined) {
        delete process.env.APP_URL;
      } else {
        process.env.APP_URL = origAppUrl;
      }
    }
  });

  test("agent-fs falls back to raw path display when org/drive ids are missing", () => {
    const origOrg = process.env.AGENT_FS_DEFAULT_ORG_ID;
    const origDrive = process.env.AGENT_FS_DEFAULT_DRIVE_ID;
    delete process.env.AGENT_FS_DEFAULT_ORG_ID;
    delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
    try {
      const out = formatAttachmentsBlockForSlack([
        mkAttachment({ kind: "agent-fs", name: "doc", path: "/thoughts/a.md" }),
      ]);
      expect(out).toContain("agent-fs:/thoughts/a.md");
      expect(out).not.toContain("live.agent-fs.dev");
    } finally {
      if (origOrg === undefined) delete process.env.AGENT_FS_DEFAULT_ORG_ID;
      else process.env.AGENT_FS_DEFAULT_ORG_ID = origOrg;
      if (origDrive === undefined) delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
      else process.env.AGENT_FS_DEFAULT_DRIVE_ID = origDrive;
    }
  });

  test("agent-fs with row-level orgId + driveId emits the live-host URL", () => {
    const origHost = process.env.AGENT_FS_LIVE_URL;
    delete process.env.AGENT_FS_LIVE_URL;
    try {
      const out = formatAttachmentsBlockForSlack([
        mkAttachment({
          kind: "agent-fs",
          name: "doc",
          path: "/thoughts/a.md",
          orgId: "org-1",
          driveId: "drive-1",
        }),
      ]);
      // Live URL strips the leading slash from `path` so the join is clean.
      expect(out).toContain("https://live.agent-fs.dev/file/~/org-1/drive-1/thoughts/a.md");
      expect(out).not.toContain("agent-fs:/thoughts/a.md");
    } finally {
      if (origHost === undefined) delete process.env.AGENT_FS_LIVE_URL;
      else process.env.AGENT_FS_LIVE_URL = origHost;
    }
  });

  test("agent-fs uses AGENT_FS_DEFAULT_* env-var fallback when row has no ids", () => {
    const origOrg = process.env.AGENT_FS_DEFAULT_ORG_ID;
    const origDrive = process.env.AGENT_FS_DEFAULT_DRIVE_ID;
    process.env.AGENT_FS_DEFAULT_ORG_ID = "fallback-org";
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = "fallback-drive";
    try {
      const out = formatAttachmentsBlockForSlack([
        mkAttachment({ kind: "agent-fs", name: "doc", path: "thoughts/a.md" }),
      ]);
      expect(out).toContain(
        "https://live.agent-fs.dev/file/~/fallback-org/fallback-drive/thoughts/a.md",
      );
    } finally {
      if (origOrg === undefined) delete process.env.AGENT_FS_DEFAULT_ORG_ID;
      else process.env.AGENT_FS_DEFAULT_ORG_ID = origOrg;
      if (origDrive === undefined) delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
      else process.env.AGENT_FS_DEFAULT_DRIVE_ID = origDrive;
    }
  });

  test("agent-fs row-level org/drive ids win over env-var fallbacks", () => {
    const origOrg = process.env.AGENT_FS_DEFAULT_ORG_ID;
    const origDrive = process.env.AGENT_FS_DEFAULT_DRIVE_ID;
    process.env.AGENT_FS_DEFAULT_ORG_ID = "fallback-org";
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = "fallback-drive";
    try {
      const out = formatAttachmentsBlockForSlack([
        mkAttachment({
          kind: "agent-fs",
          name: "doc",
          path: "thoughts/a.md",
          orgId: "row-org",
          driveId: "row-drive",
        }),
      ]);
      expect(out).toContain("https://live.agent-fs.dev/file/~/row-org/row-drive/thoughts/a.md");
      expect(out).not.toContain("fallback-org");
      expect(out).not.toContain("fallback-drive");
    } finally {
      if (origOrg === undefined) delete process.env.AGENT_FS_DEFAULT_ORG_ID;
      else process.env.AGENT_FS_DEFAULT_ORG_ID = origOrg;
      if (origDrive === undefined) delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
      else process.env.AGENT_FS_DEFAULT_DRIVE_ID = origDrive;
    }
  });

  test("shared-fs displays a swarm raw download URL", () => {
    const origAppUrl = process.env.APP_URL;
    process.env.APP_URL = "https://app.example.test";
    try {
      const out = formatAttachmentsBlockForSlack([
        mkAttachment({
          id: "11111111-1111-1111-1111-111111111111",
          taskId: "22222222-2222-2222-2222-222222222222",
          kind: "shared-fs",
          name: "log",
          path: "/var/log/x.log",
          providerId: "local-fs",
        }),
      ]);
      expect(out).toContain(
        "https://app.example.test/api/fs/tasks/22222222-2222-2222-2222-222222222222/files/11111111-1111-1111-1111-111111111111/raw",
      );
    } finally {
      if (origAppUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = origAppUrl;
    }
  });

  test("caps at 20 lines but still prints the true count in the header", () => {
    const attachments = Array.from({ length: 25 }, (_, i) =>
      mkAttachment({ kind: "url", url: `https://x.test/${i}`, name: `n${i}` }),
    );
    const out = formatAttachmentsBlockForSlack(attachments);
    // Header reports the real count.
    expect(out).toContain("Attachments (25)");
    // Body capped to 20 bullets.
    const bulletCount = (out.match(/\n• /g) ?? []).length;
    expect(bulletCount).toBe(20);
  });

  test("starts with two newlines so it concatenates cleanly with the output body", () => {
    const out = formatAttachmentsBlockForSlack([
      mkAttachment({ kind: "url", url: "https://x.test", name: "x" }),
    ]);
    expect(out.startsWith("\n\n")).toBe(true);
  });
});

describe("buildCompletedBlocks trailer", () => {
  const baseOpts = { agentName: "tester", taskId: crypto.randomUUID(), body: "Done." };

  test("includes the body block when minimal=false", () => {
    const blocks = buildCompletedBlocks(baseOpts);
    const texts = sectionTexts(blocks);
    expect(texts.some((t) => t.includes("Done."))).toBe(true);
  });

  test("suppresses body when minimal=true and no trailer", () => {
    const blocks = buildCompletedBlocks({ ...baseOpts, minimal: true });
    const texts = sectionTexts(blocks);
    expect(texts.some((t) => t.includes("Done."))).toBe(false);
  });

  test("renders the trailer (attachments) even when minimal=true", () => {
    const blocks = buildCompletedBlocks({
      ...baseOpts,
      minimal: true,
      trailer: "\n\n*Attachments (1):*\n• *report* — https://x.test",
    });
    const texts = sectionTexts(blocks);
    // Header line is always present.
    expect(texts.some((t) => t.includes("tester"))).toBe(true);
    // Trailer rendered — body still suppressed.
    expect(texts.some((t) => t.includes("Attachments (1)"))).toBe(true);
    expect(texts.some((t) => t.includes("Done."))).toBe(false);
  });
});

describe("Slack attachments block — env hygiene", () => {
  let originalAppUrl: string | undefined;
  beforeEach(() => {
    originalAppUrl = process.env.APP_URL;
  });
  afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env.APP_URL;
    } else {
      process.env.APP_URL = originalAppUrl;
    }
  });

  test("page-link falls back to DEFAULT_APP_URL when APP_URL is unset", () => {
    delete process.env.APP_URL;
    const out = formatAttachmentsBlockForSlack([mkAttachment({ kind: "page", pageId: "p42" })]);
    // DEFAULT_APP_URL is https://app.agent-swarm.dev — the production fallback
    // so links rendered out of the box still work.
    expect(out).toContain("https://app.agent-swarm.dev/pages/p42");
  });
});
