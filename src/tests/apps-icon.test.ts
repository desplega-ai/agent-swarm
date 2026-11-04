import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  type AppDefinition,
  applyAppDefinitionPatch,
  parseAppDefinition,
} from "../apps/definition";
import { createApp, getApp, listApps, updateApp } from "../apps/store";
import {
  closeDb,
  createAgent,
  getAgentById,
  getDbClient,
  initDb,
  updateAgentProfile,
} from "../be/db";
import { AgentAvatarSchema, AgentSlackIconSchema, AppIconSchema } from "../types";

const TEST_DB_PATH = `/private/tmp/test-apps-icon-${process.pid}.sqlite`;

const baseDefinition = {
  models: {},
  queries: {},
  actions: {},
  pages: {
    main: {
      title: "Main",
      root: "root",
      elements: { root: { type: "Stack", props: {}, children: [] } },
    },
  },
  defaultPage: "main",
};

async function createWithIcon(name: string, icon: unknown) {
  const parsed = await parseAppDefinition(baseDefinition, { writerIsUser: true });
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  const app = await createApp({ name, definition: parsed.definition });
  if (icon !== undefined) {
    // Write the raw column so malformed stored icons (hand edits, old data) can be exercised.
    const stored = { ...parsed.definition, icon };
    await getDbClient().run("UPDATE apps SET definition = ? WHERE id = ?", [
      JSON.stringify(stored),
      app.id,
    ]);
  }
  return app.id;
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
});

describe("app icon", () => {
  test("definition accepts a lucide icon and rejects a malformed one", async () => {
    const icon = { type: "lucide", icon: "layout-grid", color: "#f59e0b" };
    expect((await parseAppDefinition({ ...baseDefinition, icon })).success).toBe(true);
    expect(
      (await parseAppDefinition({ ...baseDefinition, icon: { type: "lucide", icon: "Not Valid" } }))
        .success,
    ).toBe(false);
    expect(
      (
        await parseAppDefinition({
          ...baseDefinition,
          icon: { type: "lucide", icon: "star", color: "red" },
        })
      ).success,
    ).toBe(false);
  });

  test('suggests "icon" for avatar and emoji top-level keys', async () => {
    for (const key of ["avatar", "emoji"]) {
      const parsed = await parseAppDefinition({ ...baseDefinition, [key]: "x" });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.issues.some((issue) => issue.message.includes('did you mean "icon"'))).toBe(
          true,
        );
      }
    }
  });

  test("an icon written through the normal create and update path survives to listApps", async () => {
    const icon = { type: "lucide", icon: "layout-grid", color: "#f59e0b" };
    const parsed = await parseAppDefinition({ ...baseDefinition, icon }, { writerIsUser: true });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
    const app = await createApp({ name: "Round trip", definition: parsed.definition });

    expect((await listApps()).find((summary) => summary.id === app.id)?.icon).toEqual(icon);
    expect((await getApp(app.id))?.definition.icon).toEqual(icon);

    const nextIcon = { type: "lucide", icon: "star" };
    const reparsed = await parseAppDefinition(
      { ...baseDefinition, icon: nextIcon },
      { writerIsUser: true },
    );
    if (!reparsed.success) throw new Error(JSON.stringify(reparsed.issues));
    await updateApp(app.id, { definition: reparsed.definition });

    expect((await listApps()).find((summary) => summary.id === app.id)?.icon).toEqual(nextIcon);
  });

  test("listApps projects a valid icon and omits it when absent or invalid", async () => {
    const icon = { type: "lucide", icon: "layout-grid", color: "#f59e0b" };
    const withIcon = await createWithIcon("With icon", icon);
    const withoutIcon = await createWithIcon("Without icon", undefined);
    const badShape = await createWithIcon("Bad shape", { type: "lucide", icon: "Not Valid" });
    const wrongType = await createWithIcon("Wrong type", "star");

    const byId = new Map((await listApps()).map((app) => [app.id, app]));
    expect(byId.get(withIcon)?.icon).toEqual(icon);
    for (const id of [withoutIcon, badShape, wrongType]) {
      const summary = byId.get(id);
      expect(summary).toBeDefined();
      expect(summary && "icon" in summary).toBe(false);
    }
  });

  test("an unknown but well-formed icon name is passed through for the dashboard to fall back on", async () => {
    const icon = { type: "lucide", icon: "no-such-icon" };
    const id = await createWithIcon("Unknown icon", icon);
    const summary = (await listApps()).find((app) => app.id === id);
    expect(summary?.icon).toEqual(icon);
  });
});

const URL_ICON = { type: "url", url: "https://example.com/icon.png" };
const AGENT_FS_ICON = { type: "agent-fs", path: "/apps/abc/icon-1.png" };
const AGENT_FS_ICON_WITH_DRIVE = {
  type: "agent-fs",
  path: "/apps/abc/icon-1.png",
  orgId: "org-1",
  driveId: "drive-1",
};

async function parseWithIcon(icon: unknown) {
  return parseAppDefinition({ ...baseDefinition, icon }, { writerIsUser: true });
}

async function storedDefinition(icon: unknown): Promise<AppDefinition> {
  const parsed = await parseWithIcon(icon);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.issues));
  return parsed.definition;
}

describe("app icon url variant", () => {
  test("accepts an https link", async () => {
    expect(AppIconSchema.safeParse(URL_ICON).success).toBe(true);
    expect((await parseWithIcon(URL_ICON)).success).toBe(true);
  });

  test("rejects http, javascript:, credentials, and links over 2048 characters", async () => {
    const bad = [
      "http://example.com/icon.png",
      "javascript:alert(1)",
      "https://user:pass@example.com/icon.png",
      `https://example.com/${"a".repeat(2048)}`,
    ];
    for (const url of bad) {
      expect(AppIconSchema.safeParse({ type: "url", url }).success).toBe(false);
      expect((await parseWithIcon({ type: "url", url })).success).toBe(false);
    }
  });

  test("Slack icons share the same https link rules", () => {
    expect(AgentSlackIconSchema.safeParse(URL_ICON).success).toBe(true);
    expect(
      AgentSlackIconSchema.safeParse({ type: "url", url: "http://example.com/i.png" }).success,
    ).toBe(false);
  });
});

describe("app icon agent-fs variant", () => {
  test("accepts a path alone or with both drive IDs", async () => {
    for (const icon of [AGENT_FS_ICON, AGENT_FS_ICON_WITH_DRIVE]) {
      expect(AppIconSchema.safeParse(icon).success).toBe(true);
      expect((await parseWithIcon(icon)).success).toBe(true);
    }
  });

  test("rejects a relative path, a .. segment, and a single drive ID", async () => {
    const bad = [
      { type: "agent-fs", path: "apps/abc/icon.png" },
      { type: "agent-fs", path: "/apps/../secrets/icon.png" },
      { type: "agent-fs", path: "/apps/abc/icon.png", orgId: "org-1" },
      { type: "agent-fs", path: "/apps/abc/icon.png", driveId: "drive-1" },
    ];
    for (const icon of bad) {
      expect(AppIconSchema.safeParse(icon).success).toBe(false);
      expect((await parseWithIcon(icon)).success).toBe(false);
    }
  });
});

describe("app icon variants round trip", () => {
  test("parseAppDefinition -> createApp -> listApps keeps each variant", async () => {
    for (const icon of [URL_ICON, AGENT_FS_ICON, AGENT_FS_ICON_WITH_DRIVE]) {
      const app = await createApp({
        name: `Round trip ${icon.type}`,
        definition: await storedDefinition(icon),
      });
      expect((await listApps()).find((summary) => summary.id === app.id)?.icon).toEqual(icon);
      expect((await getApp(app.id))?.definition.icon).toEqual(icon);
    }
  });
});

describe("app icon merge patch", () => {
  test("switching from lucide with color to url leaves no lucide keys", async () => {
    const stored = await storedDefinition({ type: "lucide", icon: "star", color: "#f59e0b" });
    const patched = applyAppDefinitionPatch(stored, { icon: URL_ICON });
    expect(patched.success).toBe(true);
    if (patched.success) {
      expect((patched.definition as { icon: unknown }).icon).toEqual(URL_ICON);
      const reparsed = await parseAppDefinition(patched.definition, { writerIsUser: true });
      expect(reparsed.success).toBe(true);
    }
  });

  test("switching from agent-fs to lucide leaves no agent-fs keys", async () => {
    const stored = await storedDefinition(AGENT_FS_ICON_WITH_DRIVE);
    const lucide = { type: "lucide", icon: "star" };
    const patched = applyAppDefinitionPatch(stored, { icon: lucide });
    expect(patched.success).toBe(true);
    if (patched.success) {
      expect((patched.definition as { icon: unknown }).icon).toEqual(lucide);
    }
  });

  test("a null icon removes it", async () => {
    const stored = await storedDefinition(URL_ICON);
    const patched = applyAppDefinitionPatch(stored, { icon: null });
    expect(patched.success).toBe(true);
    if (patched.success) expect("icon" in (patched.definition as object)).toBe(false);
  });
});

describe("agent avatars take the same icons", () => {
  test("AgentAvatarSchema accepts lucide, url and agent-fs icons", () => {
    expect(AgentAvatarSchema.safeParse({ type: "lucide", icon: "bot" }).success).toBe(true);
    expect(AgentAvatarSchema.safeParse(URL_ICON).success).toBe(true);
    expect(AgentAvatarSchema.safeParse(AGENT_FS_ICON).success).toBe(true);
  });

  test("AgentAvatarSchema rejects http links and a single drive ID", () => {
    expect(
      AgentAvatarSchema.safeParse({ type: "url", url: "http://example.com/x.png" }).success,
    ).toBe(false);
    expect(
      AgentAvatarSchema.safeParse({ type: "agent-fs", path: "/agents/a/avatar.png", orgId: "o" })
        .success,
    ).toBe(false);
  });

  test("a url avatar round trips through the profile update, then an agent-fs one replaces it", async () => {
    const agent = await createAgent({ name: "Avatar Agent", isLead: false, status: "idle" });
    await updateAgentProfile(agent.id, { avatar: URL_ICON });
    expect((await getAgentById(agent.id))?.avatar).toEqual(URL_ICON);

    const fsAvatar = { type: "agent-fs" as const, path: `/agents/${agent.id}/avatar-1.png` };
    await updateAgentProfile(agent.id, { avatar: fsAvatar });
    expect((await getAgentById(agent.id))?.avatar).toEqual(fsAvatar);

    await updateAgentProfile(agent.id, { avatar: null });
    expect((await getAgentById(agent.id))?.avatar).toBeNull();
  });
});
