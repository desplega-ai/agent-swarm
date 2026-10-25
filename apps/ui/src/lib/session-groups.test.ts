import { describe, expect, test } from "bun:test";
import type { AgentTaskSource, SessionTreeGroup } from "../api/types";
import { stillEmpty, withEmptyGroups } from "./empty-groups";
import {
  buildSessionGroupTree,
  chatSourceOf,
  defaultSessionKey,
  groupCrumb,
  groupKeyOf,
  groupLabel,
  groupSlug,
  groupTargets,
  groupWriteBlock,
  isNoGroupKey,
  PERSONAL_WRITE_REASON,
  personalOwner,
  renamedGroupKey,
  restoreKey,
  sessionSourceOf,
  sourceGroupLabel,
  sourceOfGroupKey,
} from "./session-groups";

const ME = "me-1";

function group(
  key: string,
  lastActivityAt: string,
  counts: Partial<Omit<SessionTreeGroup, "key" | "lastActivityAt">> = {},
): SessionTreeGroup {
  return { key, lastActivityAt, total: 1, unread: 0, running: 0, needsYou: 0, ...counts };
}

describe("buildSessionGroupTree", () => {
  test("nests groups by slash and adds a parent for every prefix", () => {
    const tree = buildSessionGroupTree(
      [
        group("shared/northwind/pricing/", "2026-10-21T10:00:00.000Z", { total: 4, unread: 2 }),
        group("shared/northwind/ios/", "2026-10-21T09:00:00.000Z", { total: 3, running: 1 }),
        group("shared/infra/", "2026-10-20T09:00:00.000Z", { total: 2, needsYou: 1 }),
      ],
      ME,
    );
    expect(tree.myGroups.map((node) => node.key)).toEqual(["shared/northwind/", "shared/infra/"]);
    const northwind = tree.myGroups[0];
    expect(northwind.name).toBe("northwind");
    expect(northwind.own).toEqual({ total: 0, unread: 0, running: 0, needsYou: 0 });
    expect(northwind.children.map((node) => node.name)).toEqual(["pricing", "ios"]);
    expect(northwind.lastActivityAt).toBe("2026-10-21T10:00:00.000Z");
  });

  test("a folded group shows its subtree, an open one its own sessions", () => {
    const tree = buildSessionGroupTree(
      [
        group("shared/a/", "2026-10-21T08:00:00.000Z", { total: 1, unread: 1 }),
        group("shared/a/b/", "2026-10-21T09:00:00.000Z", { total: 2, unread: 1, running: 1 }),
        group("shared/a/b/c/", "2026-10-21T07:00:00.000Z", { total: 3, needsYou: 2 }),
      ],
      ME,
    );
    const a = tree.myGroups[0];
    expect(a.own).toEqual({ total: 1, unread: 1, running: 0, needsYou: 0 });
    expect(a.subtree).toEqual({ total: 6, unread: 2, running: 1, needsYou: 2 });
    expect(a.children[0].subtree).toEqual({ total: 5, unread: 1, running: 1, needsYou: 2 });
    expect(tree.myGroupsTotal).toBe(6);
  });

  test("my personal groups sit in My groups by name, with no namespace prefix", () => {
    const tree = buildSessionGroupTree(
      [group(`personal/${ME}/notes/`, "2026-10-21T10:00:00.000Z")],
      ME,
    );
    expect(tree.myGroups).toHaveLength(1);
    expect(tree.myGroups[0].name).toBe("notes");
    expect(tree.myGroups[0].privateClash).toBe(false);
    expect(tree.sharedWithMe).toEqual([]);
  });

  test("a personal group whose path a shared group also uses gets the lock", () => {
    const tree = buildSessionGroupTree(
      [
        group(`personal/${ME}/infra/`, "2026-10-21T10:00:00.000Z"),
        group("shared/infra/", "2026-10-21T09:00:00.000Z"),
        group(`personal/${ME}/notes/`, "2026-10-21T08:00:00.000Z"),
      ],
      ME,
    );
    const byKey = new Map(tree.myGroups.map((node) => [node.key, node]));
    expect(byKey.get(`personal/${ME}/infra/`)?.privateClash).toBe(true);
    expect(byKey.get("shared/infra/")?.privateClash).toBe(false);
    expect(byKey.get(`personal/${ME}/notes/`)?.privateClash).toBe(false);
  });

  test("other people's personal groups go under Shared with me, one node per owner", () => {
    const tree = buildSessionGroupTree(
      [
        group("personal/lena/notes/q4/", "2026-10-21T08:00:00.000Z", { total: 2, unread: 1 }),
        group("personal/lena/", "2026-10-21T09:00:00.000Z"),
        group("personal/marco/drafts/", "2026-10-21T10:00:00.000Z", { total: 3 }),
      ],
      ME,
    );
    expect(tree.myGroups).toEqual([]);
    expect(tree.sharedWithMe.map((owner) => owner.ownerId)).toEqual(["marco", "lena"]);
    const lena = tree.sharedWithMe[1];
    expect(lena.groups.map((node) => node.name)).toEqual(["", "notes › q4"]);
    expect(lena.subtree).toEqual({ total: 3, unread: 1, running: 0, needsYou: 0 });
    expect(tree.sharedWithMeTotal).toBe(6);
  });

  test("No group keys stay out of the tree", () => {
    const tree = buildSessionGroupTree(
      [
        group("shared/", "2026-10-21T10:00:00.000Z"),
        group(`personal/${ME}/`, "2026-10-21T10:00:00.000Z"),
      ],
      ME,
    );
    expect(tree.myGroups).toEqual([]);
    expect(tree.sharedWithMe).toEqual([]);
  });

  test("with no picked user, every personal group belongs to another person", () => {
    const tree = buildSessionGroupTree(
      [
        group(`personal/${ME}/notes/`, "2026-10-21T10:00:00.000Z"),
        group("shared/x/", "2026-10-21T09:00:00.000Z"),
      ],
      null,
    );
    expect(tree.myGroups.map((node) => node.key)).toEqual(["shared/x/"]);
    expect(tree.sharedWithMe.map((owner) => owner.ownerId)).toEqual([ME]);
  });

  test("groups with the same activity sort by name, so polls never reorder them", () => {
    const at = "2026-10-21T10:00:00.000Z";
    const tree = buildSessionGroupTree([group("shared/b/", at), group("shared/a/", at)], ME);
    expect(tree.myGroups.map((node) => node.name)).toEqual(["a", "b"]);
  });
});

describe("group keys", () => {
  test("isNoGroupKey matches shared/ and my own personal root only", () => {
    expect(isNoGroupKey("shared/", ME)).toBe(true);
    expect(isNoGroupKey(`personal/${ME}/`, ME)).toBe(true);
    expect(isNoGroupKey("personal/lena/", ME)).toBe(false);
    expect(isNoGroupKey(`personal/${ME}/`, null)).toBe(false);
    expect(isNoGroupKey("shared/a/", ME)).toBe(false);
  });

  test("personalOwner reads the owner of a personal key", () => {
    expect(personalOwner("personal/lena/notes/")).toBe("lena");
    expect(personalOwner("shared/a/")).toBeNull();
  });

  test("groupLabel is the last segment, empty for No group", () => {
    expect(groupLabel("shared/northwind/pricing/", ME)).toBe("pricing");
    expect(groupLabel(`personal/${ME}/notes/`, ME)).toBe("notes");
    expect(groupLabel("shared/release:v2/", ME)).toBe("release:v2");
    expect(groupLabel("shared/", ME)).toBe("");
    expect(groupLabel(`personal/${ME}/`, ME)).toBe("");
    expect(groupLabel("personal/lena/", ME)).toBe("");
    expect(groupLabel(undefined, ME)).toBe("");
  });

  test("groupCrumb joins the path and names the owner of another person's group", () => {
    const nameOf = (id: string) => (id === "lena" ? "Lena" : id);
    expect(groupCrumb("shared/northwind/pricing/", ME, nameOf)).toBe("northwind › pricing");
    expect(groupCrumb(`personal/${ME}/notes/`, ME, nameOf)).toBe("notes");
    expect(groupCrumb("personal/lena/notes/", ME, nameOf)).toBe("Lena › notes");
    expect(groupCrumb("shared/", ME, nameOf)).toBe("No group");
  });
});

describe("move targets and new groups (Phase 5)", () => {
  test("groupKeyOf drops a session leaf only when it is a whole segment", () => {
    expect(groupKeyOf("shared/task:abc/")).toBe("shared/");
    expect(groupKeyOf("shared/northwind/schedule:s1/")).toBe("shared/northwind/");
    expect(groupKeyOf("shared/northwind/pricing/")).toBe("shared/northwind/pricing/");
    expect(groupKeyOf("shared/footask:x/")).toBe("shared/footask:x/");
  });

  test("groupTargets lists every group and parent, shared first, by path", () => {
    const tree = buildSessionGroupTree(
      [
        group(`personal/${ME}/notes/`, "2026-10-21T09:00:00.000Z"),
        group("shared/northwind/pricing/", "2026-10-21T10:00:00.000Z"),
        group("shared/infra/", "2026-10-21T08:00:00.000Z"),
        group("personal/other/x/", "2026-10-21T08:00:00.000Z"),
      ],
      ME,
    );
    expect(groupTargets(tree, ME).map((target) => [target.key, target.label])).toEqual([
      ["shared/infra/", "infra"],
      ["shared/northwind/", "northwind"],
      ["shared/northwind/pricing/", "northwind › pricing"],
      [`personal/${ME}/notes/`, "notes"],
    ]);
  });

  test("a group name becomes one safe key segment", () => {
    expect(groupSlug("  QA Bulk  ")).toBe("qa-bulk");
    expect(groupSlug("task:123 / sub")).toBe("task123--sub");
    expect(groupSlug("..")).toBe("");
    expect(renamedGroupKey("shared/a/b/", "New Name")).toBe("shared/a/new-name/");
    expect(renamedGroupKey("shared/a/", "!!")).toBeNull();
  });

  test("an empty group stays until the server has it or a group inside it", () => {
    const local = ["shared/qa/", "shared/new/"];
    expect(stillEmpty(local, ["shared/qa/sub/", "shared/infra/"])).toEqual(["shared/new/"]);
    const merged = withEmptyGroups([group("shared/infra/", "2026-10-21T08:00:00.000Z")], local);
    expect(merged.map((g) => [g.key, g.total])).toEqual([
      ["shared/infra/", 1],
      ["shared/qa/", 0],
      ["shared/new/", 0],
    ]);
  });
});

describe("Undo keys and personal writes (Phase 5 fixes)", () => {
  test("restoreKey sends null only when null gives the same key back", () => {
    expect(defaultSessionKey("r1")).toBe("shared/task:r1/");
    expect(restoreKey("r1", "shared/task:r1/")).toBeNull();
    expect(restoreKey("r1", `personal/${ME}/task:r1/`)).toBe(`personal/${ME}/task:r1/`);
    expect(restoreKey("r1", "shared/schedule:s9/")).toBe("shared/schedule:s9/");
    expect(restoreKey("r1", "shared/northwind/pricing/")).toBe("shared/northwind/pricing/");
    // Another session's default key is not this one's.
    expect(restoreKey("r1", "shared/task:r2/")).toBe("shared/task:r2/");
  });

  test("only writes into a personal key need a user token", () => {
    expect(groupWriteBlock(`personal/${ME}/notes/`, false)).toBe(PERSONAL_WRITE_REASON);
    expect(groupWriteBlock(`personal/${ME}/notes/`, true)).toBeNull();
    expect(groupWriteBlock("shared/infra/", false)).toBeNull();
    // No group (a move out of a personal group) works on the operator key.
    expect(groupWriteBlock(null, false)).toBeNull();
  });
});

describe("source sections (sources Phase 5)", () => {
  const at = (hour: number) => `2026-10-25T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const labels = {
    "shared/slack/c0eng00001/": "#eng",
    "shared/slack/d0dm000001/": "DM · Lena",
    "shared/telegram/-1001/": "Northwind ops",
  };
  const tree = buildSessionGroupTree(
    [
      group("shared/telegram/-1001/", at(9), { total: 2 }),
      group("shared/slack/c0eng00001/", at(8), { total: 3, unread: 1 }),
      group("shared/slack/d0dm000001/", at(11), { total: 1, running: 1 }),
      group("shared/slack/c0ops00001/", at(7)),
      group("shared/infra/", at(6)),
    ],
    ME,
    labels,
  );

  test("source keys leave My groups, and so every move and Start in target", () => {
    expect(tree.myGroups.map((node) => node.key)).toEqual(["shared/infra/"]);
    expect(tree.myGroupsTotal).toBe(1);
    expect(groupTargets(tree, ME).map((target) => target.key)).toEqual(["shared/infra/"]);
  });

  test("one section per source with groups, in source order, newest group first", () => {
    expect(tree.sources.map((section) => section.source)).toEqual(["slack", "telegram"]);
    const slack = tree.sources[0];
    // The row's `#` icon says channel: the name drops the label's `#`.
    expect(slack.nodes.map((node) => node.name)).toEqual(["DM · Lena", "eng", "C0OPS00001"]);
    expect(slack.counts).toEqual({ total: 5, unread: 1, running: 1, needsYou: 0 });
    expect(tree.sources[1].nodes.map((node) => node.name)).toEqual(["Northwind ops"]);
  });

  test("a DM gets the person icon, a channel the hash", () => {
    const slack = new Map(tree.sources[0].nodes.map((node) => [node.key, node.dm]));
    expect(slack.get("shared/slack/d0dm000001/")).toBe(true);
    expect(slack.get("shared/slack/c0eng00001/")).toBe(false);
    // A Telegram private chat has a positive id, a group a negative one.
    const telegram = buildSessionGroupTree(
      [group("shared/telegram/42/", at(9)), group("shared/telegram/-1001/", at(8))],
      ME,
    ).sources[0].nodes;
    expect(telegram.map((node) => [node.key, node.dm])).toEqual([
      ["shared/telegram/42/", true],
      ["shared/telegram/-1001/", false],
    ]);
    // A Discord DM is known by its label only.
    const discord = buildSessionGroupTree([group("shared/discord/77/", at(9))], ME, {
      "shared/discord/77/": "DM · Marco",
    }).sources[0].nodes;
    expect(discord[0].dm).toBe(true);
  });

  test("a thread nests under its channel with its title and conversation icon", () => {
    const thread = "shared/slack/c1/thread:1.2/";
    const nested = buildSessionGroupTree(
      [group("shared/slack/c1/", at(8)), group(thread, at(9), { total: 2, unread: 1 })],
      ME,
      { "shared/slack/c1/": "#eng", [thread]: "#Review the release" },
    );
    expect(nested.myGroups).toEqual([]);
    const channel = nested.sources[0].nodes[0];
    expect(channel.key).toBe("shared/slack/c1/");
    expect(channel.name).toBe("eng");
    expect(channel.own.total).toBe(1);
    expect(channel.subtree.total).toBe(3);
    expect(channel.children[0]).toMatchObject({
      key: thread,
      name: "#Review the release",
      thread: true,
      dm: false,
      own: { total: 2, unread: 1, running: 0, needsYou: 0 },
    });
    expect(nested.sources[0].counts.total).toBe(3);
    expect(groupTargets(nested, ME)).toEqual([]);
    expect(groupLabel(thread, ME, { [thread]: "Review the release" })).toBe("Review the release");
    expect(groupCrumb(thread, ME, () => "", { [thread]: "Review the release" })).toBe(
      "Slack › Review the release",
    );
  });

  test("thread groups have a readable fallback and never use the DM icon", () => {
    for (const base of ["shared/slack/d1/", "shared/telegram/42/", "shared/discord/77/"]) {
      const key = `${base}thread:1.2/`;
      const tree = buildSessionGroupTree([group(key, at(9), { total: 2 })], ME, {
        [key]: "DM · Discuss the release",
      });
      const parent = tree.sources[0].nodes[0];
      expect(parent.children[0]).toMatchObject({
        name: "DM · Discuss the release",
        thread: true,
        dm: false,
      });
      expect(sourceGroupLabel(key)).toBe("Thread · 1.2");
      expect(groupLabel(key, ME)).toBe("Thread · 1.2");
      expect(groupCrumb(key, ME, () => "")).toEndWith(" › Thread · 1.2");
    }
  });

  test("a thread label that is a prompt preview reads as its title line", () => {
    const channel = "shared/slack/c1/";
    const thread = `${channel}thread:1.2/`;
    const labels = {
      [channel]: "#eng",
      [thread]:
        "[Thread follow-up — 2 message(s) buffered]\n\n<@U1|Lena>: Ship the release\nDetails",
    };
    const tree = buildSessionGroupTree(
      [group(channel, at(8)), group(thread, at(9), { total: 2 })],
      ME,
      labels,
    );
    expect(tree.sources[0].nodes[0].children[0].name).toBe("Ship the release");
    expect(groupCrumb(thread, ME, () => "", labels)).toBe("Slack › Ship the release");
    // A channel label is a name, not a prompt.
    expect(sourceGroupLabel(channel, labels)).toBe("#eng");
    // A custom title or a cached topic name reads as it is.
    for (const name of ["Release thread: first ask", "#Review the release", "Q4 · launch topic"]) {
      expect(sourceGroupLabel(thread, { [thread]: name })).toBe(name);
    }
  });

  test("no source groups: no sections", () => {
    expect(buildSessionGroupTree([group("shared/a/", at(8))], ME).sources).toEqual([]);
  });

  test("sourceOfGroupKey reads the source prefix only", () => {
    expect(sourceOfGroupKey("shared/slack/c1/")).toBe("slack");
    expect(sourceOfGroupKey("shared/telegram/-1001/")).toBe("telegram");
    expect(sourceOfGroupKey("shared/discord/77/")).toBe("discord");
    expect(sourceOfGroupKey("shared/slackers/")).toBeNull();
    expect(sourceOfGroupKey("shared/teams/x/")).toBeNull();
    expect(sourceOfGroupKey("personal/me-1/slack/x/")).toBeNull();
  });

  test("sourceGroupLabel: the label, else a name from the id", () => {
    expect(sourceGroupLabel("shared/slack/c0ar967k0kz/", labels)).toBe("#C0AR967K0KZ");
    expect(sourceGroupLabel("shared/slack/c0eng00001/", labels)).toBe("#eng");
    expect(sourceGroupLabel("shared/slack/g0private1/")).toBe("#G0PRIVATE1");
    expect(sourceGroupLabel("shared/slack/d0dm000002/")).toBe("DM");
    expect(sourceGroupLabel("shared/telegram/-1002/")).toBe("-1002");
    expect(sourceGroupLabel("shared/discord/123456/")).toBe("123456");
    expect(sourceGroupLabel("shared/slack/c1/thread:1.2/")).toBe("Thread · 1.2");
  });

  test("flat rows, cards, toasts, and crumbs name a source group by its label (sources Phase 6)", () => {
    // The flat row label keeps the `#`: no hash icon sits next to it.
    expect(groupLabel("shared/slack/c0eng00001/", ME, labels)).toBe("#eng");
    expect(groupLabel("shared/slack/d0dm000001/", ME, labels)).toBe("DM · Lena");
    expect(groupLabel("shared/telegram/-1001/", ME, labels)).toBe("Northwind ops");
    expect(groupLabel("shared/slack/c0ar967k0kz/", ME)).toBe("#C0AR967K0KZ");
    expect(groupLabel("shared/slack/", ME)).toBe("Slack");
    expect(groupCrumb("shared/slack/c0eng00001/", ME, () => "", labels)).toBe("Slack › #eng");
    expect(groupCrumb("shared/telegram/-1001/", ME, () => "", labels)).toBe(
      "Telegram › Northwind ops",
    );
    expect(groupCrumb("shared/discord/123456/", ME, () => "")).toBe("Discord › 123456");
    expect(groupCrumb("shared/slack/", ME, () => "")).toBe("Slack");
    // Other keys keep their path.
    expect(groupCrumb("shared/infra/", ME, () => "", labels)).toBe("infra");
  });

  test("groupWriteBlock has no source rule, so Undo after a move out still works", () => {
    // Read-only shows in the tree (no menu, "+", or drop) and in the server guard.
    expect(groupWriteBlock("shared/slack/c0eng00001/", false)).toBeNull();
    expect(groupWriteBlock("shared/slack/c0eng00001/thread:1.2/", true)).toBeNull();
  });
});

describe("session source marks (sources Phase 6)", () => {
  const root = (key: string, source: string, tags: string[] = []) => ({
    key,
    source: source as AgentTaskSource,
    tags,
  });

  test("a source key wins, so an agent session in a Slack thread is Slack", () => {
    expect(sessionSourceOf(root("shared/slack/c1/thread:1.2/", "mcp"))).toBe("slack");
    expect(sessionSourceOf(root("shared/telegram/-1001/task:t1/", "chat"))).toBe("telegram");
  });

  test("a chat root out of its section keeps its adapter, else it is chat", () => {
    expect(sessionSourceOf(root("shared/infra/", "chat", ["chat-sdk", "discord"]))).toBe("discord");
    expect(sessionSourceOf(root("shared/", "chat", ["chat-sdk", "teams"]))).toBe("chat");
  });

  test("any other root keeps its task source", () => {
    expect(sessionSourceOf(root("shared/infra/", "slack"))).toBe("slack");
    expect(sessionSourceOf(root("shared/task:t1/", "ui"))).toBe("ui");
  });

  test("only chat sessions show a mark on a row", () => {
    expect(chatSourceOf(root("shared/slack/c1/thread:1.2/", "mcp"))).toBe("slack");
    expect(chatSourceOf(root("shared/", "chat", ["chat-sdk", "teams"]))).toBe("chat");
    expect(chatSourceOf(root("shared/task:t1/", "ui"))).toBeNull();
    expect(chatSourceOf(root("shared/task:t1/", "github"))).toBeNull();
  });
});
