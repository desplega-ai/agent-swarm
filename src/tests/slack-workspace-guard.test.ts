/**
 * Inbound workspace guard: a Slack app shared by several swarms delivers each
 * payload to any of the app's sockets, whatever its workspace. A delivery not
 * proven to belong to this swarm's installation must reach no listener and get
 * no ack, so Slack redelivers it and the owner can still receive it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { SlackMock } from "@desplega.ai/slack-mock";
import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { type SlackHarness, startSlackMock, stopSlackMock } from "../../scripts/e2e/slack";
import { repoRoot } from "../../scripts/e2e/sut";
import { closeDb, initDb } from "../be/db";
import { setSlackStartRetryDelaysForTests, startSlackApp, stopSlackApp } from "../slack/app";
import { getSlackConnectionState } from "../slack/connection-state";
import {
  getSlackInboundDiagnostics,
  resetSlackInboundCountersForTests,
  runAdmittedSlackDelivery,
  slackInboundOutcomeMiddleware,
} from "../slack/inbound-dispatch";
import { installSocketAckRecovery } from "../slack/socket-ack";
import {
  classifyInboundOwnership,
  getCachedSlackWorkspaceIdentity,
  getSlackWorkspaceIdentity,
  identityFromAuthTest,
  installSocketWorkspaceGate,
  isSlackEnterpriseInstall,
  readInboundInstallations,
  resetSlackWorkspaceGuardForTests,
  resolveSlackIdentity,
  type SlackWorkspaceIdentity,
  setSlackWorkspaceIdentitySource,
} from "../slack/workspace-guard";

const TEST_DB_PATH = "./test-slack-workspace-guard.sqlite";
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
};
let savedMigrationTemplate: Uint8Array | undefined;

function removeTestDb(): void {
  for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    try {
      unlinkSync(path);
    } catch {
      // The SQLite sidecars are not always created.
    }
  }
}

beforeAll(() => {
  closeDb();
  savedMigrationTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
  removeTestDb();
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  resetSlackWorkspaceGuardForTests();
  closeDb();
  removeTestDb();
  testGlobals.__testMigrationTemplate = savedMigrationTemplate;
});

beforeEach(() => {
  resetSlackWorkspaceGuardForTests();
  resetSlackInboundCountersForTests();
});

afterEach(() => {
  resetSlackWorkspaceGuardForTests();
});

const OWN: SlackWorkspaceIdentity = {
  teamId: "T_OWN",
  enterpriseId: null,
  isEnterpriseInstall: false,
};
const GRID_WORKSPACE: SlackWorkspaceIdentity = {
  teamId: "T_OWN",
  enterpriseId: "E_ORG",
  isEnterpriseInstall: false,
  botId: "B_WS",
};
const ORG_INSTALL: SlackWorkspaceIdentity = {
  teamId: null,
  enterpriseId: "E_ORG",
  isEnterpriseInstall: true,
  botId: "B_ORG",
};

// The documented slash command payload (docs.slack.dev/interactivity/implementing-slash-commands):
// team_id and enterprise_id, no is_enterprise_install.
function documentedCommand(teamId: string, enterpriseId: string | null) {
  return {
    token: "verification",
    team_id: teamId,
    team_domain: "example",
    ...(enterpriseId
      ? { enterprise_id: enterpriseId, enterprise_name: "Globular Construct Inc" }
      : {}),
    channel_id: "C2147483705",
    channel_name: "test",
    user_id: "U2147483697",
    command: "/swarm",
    text: "status",
    api_app_id: "A123456",
    response_url: "https://hooks.slack.com/commands/1/2",
    trigger_id: "1.2.3",
  };
}

// A BlockAction (docs.slack.dev/tools/bolt-js/reference/interfaces/BlockAction):
// is_enterprise_install is optional, and team is null for an org-wide install.
// `botId` adds the message the button is on, posted by that installation's bot.
function blockAction(
  team: { id: string; enterprise_id?: string } | null,
  enterpriseId: string | null,
  flag?: boolean,
  botId?: string,
) {
  return {
    type: "block_actions",
    team,
    enterprise: enterpriseId ? { id: enterpriseId, name: "Org" } : null,
    user: { id: "U_HUMAN", team_id: team?.id ?? "T_GRANTED" },
    api_app_id: "A123456",
    token: "verification",
    trigger_id: "1.2.3",
    response_url: "https://hooks.slack.com/actions/1/2",
    container: { type: "message", message_ts: "1.000001", channel_id: "C_1" },
    channel: { id: "C_1", name: "general" },
    actions: [{ type: "button", action_id: "follow_up_task", block_id: "b", action_ts: "1.1" }],
    ...(botId ? { message: { type: "message", bot_id: botId, ts: "1.000001", text: "x" } } : {}),
    ...(flag === undefined ? {} : { is_enterprise_install: flag }),
  };
}

function resolveIdentityFor(
  identity: SlackWorkspaceIdentity,
): Promise<SlackWorkspaceIdentity | null> {
  setSlackWorkspaceIdentitySource(async () => identity);
  return getSlackWorkspaceIdentity();
}

function authorization(teamId: string | null, enterpriseId: string | null, orgWide: boolean) {
  return { team_id: teamId, enterprise_id: enterpriseId, is_enterprise_install: orgWide };
}

function eventBody(teamId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: teamId,
    api_app_id: "A_SHARED",
    event_id: `Ev_${teamId}_${Math.random().toString(36).slice(2)}`,
    authorizations: [authorization(teamId, null, false)],
    event: {
      type: "app_mention",
      channel: "C_1",
      ts: "1.000001",
      user: "U_HUMAN",
      text: "<@U_BOT> secret plans",
    },
    ...extra,
  };
}

function classify(identity: SlackWorkspaceIdentity | null, body: unknown) {
  return classifyInboundOwnership(identity, readInboundInstallations(body));
}

const OWN_RESULT = { own: true };
const FOREIGN = { own: false, reason: "foreign_workspace" };
const UNVERIFIED = { own: false, reason: "unverified_workspace" };

describe("readInboundInstallations", () => {
  test("Events API: only authorizations count, never the top-level team_id", () => {
    // Slack Connect: the top-level team can be the partner workspace.
    expect(
      readInboundInstallations({
        type: "event_callback",
        team_id: "T_PARTNER",
        authorizations: [authorization("T_OWN", "E_1", false)],
      }),
    ).toEqual([{ teamId: "T_OWN", enterpriseId: "E_1", isEnterpriseInstall: false }]);
    expect(readInboundInstallations({ type: "event_callback", team_id: "T_OWN" })).toEqual([]);
  });

  test("interactive payloads: team.id, enterprise.id and is_enterprise_install", () => {
    expect(
      readInboundInstallations({
        type: "block_actions",
        team: { id: "T_A" },
        enterprise: { id: "E_A" },
        is_enterprise_install: false,
      }),
    ).toEqual([{ teamId: "T_A", enterpriseId: "E_A", isEnterpriseInstall: false }]);
  });

  test("slash commands: string flags", () => {
    expect(
      readInboundInstallations({
        command: "/swarm",
        team_id: "T_A",
        enterprise_id: "E_A",
        is_enterprise_install: "true",
      }),
    ).toEqual([{ teamId: "T_A", enterpriseId: "E_A", isEnterpriseInstall: true }]);
  });

  test("payload with no installation field", () => {
    expect(readInboundInstallations({ type: "event_callback", event: {} })).toEqual([]);
    expect(readInboundInstallations(undefined)).toEqual([]);
    expect(readInboundInstallations({ team: null, authorizations: [] })).toEqual([]);
  });
});

describe("classifyInboundOwnership", () => {
  test("own and foreign workspace", () => {
    expect(classify(OWN, eventBody("T_OWN"))).toEqual(OWN_RESULT);
    expect(classify(OWN, eventBody("T_OTHER"))).toEqual(FOREIGN);
  });

  test("fails closed without an identity or an installation field", () => {
    expect(classify(null, eventBody("T_OWN"))).toEqual(UNVERIFIED);
    expect(classify(OWN, { type: "event_callback", event: {} })).toEqual(UNVERIFIED);
    expect(classify(OWN, { command: "/swarm" })).toEqual(UNVERIFIED);
  });

  test("a workspace install never matches on the enterprise alone", () => {
    // Sibling workspace of the same org.
    expect(
      classify(GRID_WORKSPACE, {
        type: "event_callback",
        authorizations: [authorization("T_SIBLING", "E_ORG", false)],
      }),
    ).toEqual(FOREIGN);
    // Org-only authorization: an org-wide install of the same app in our org.
    expect(
      classify(GRID_WORKSPACE, {
        type: "event_callback",
        authorizations: [authorization(null, "E_ORG", true)],
      }),
    ).toEqual(FOREIGN);
    // Interactive and command payloads with no workspace.
    expect(
      classify(GRID_WORKSPACE, { type: "block_actions", enterprise: { id: "E_ORG" } }),
    ).toEqual(FOREIGN);
    expect(classify(GRID_WORKSPACE, { command: "/swarm", enterprise_id: "E_ORG" })).toEqual(
      FOREIGN,
    );
    // Our workspace id on a delivery made to an org-wide install is not ours either.
    expect(
      classify(GRID_WORKSPACE, {
        type: "block_actions",
        team: { id: "T_OWN" },
        enterprise: { id: "E_ORG" },
        is_enterprise_install: true,
      }),
    ).toEqual(FOREIGN);
    expect(
      classify(GRID_WORKSPACE, {
        type: "event_callback",
        authorizations: [authorization("T_OWN", "E_ORG", false)],
      }),
    ).toEqual(OWN_RESULT);
  });

  test("an org-wide install matches only deliveries made to an org-wide install", () => {
    expect(
      classify(ORG_INSTALL, {
        type: "event_callback",
        team_id: "T_ANY_WORKSPACE",
        authorizations: [authorization(null, "E_ORG", true)],
      }),
    ).toEqual(OWN_RESULT);
    expect(
      classify(ORG_INSTALL, {
        type: "block_actions",
        team: { id: "T_ANY_WORKSPACE" },
        enterprise: { id: "E_ORG" },
        is_enterprise_install: true,
      }),
    ).toEqual(OWN_RESULT);
    // A workspace-level install in our org belongs to another installation.
    expect(
      classify(ORG_INSTALL, {
        type: "event_callback",
        authorizations: [authorization("T_WS", "E_ORG", false)],
      }),
    ).toEqual(FOREIGN);
    // A delivery marked as a workspace-level install is not the org install's.
    expect(
      classify(ORG_INSTALL, {
        type: "block_actions",
        enterprise: { id: "E_ORG" },
        is_enterprise_install: false,
      }),
    ).toEqual(FOREIGN);
    expect(
      classify(ORG_INSTALL, {
        type: "event_callback",
        authorizations: [authorization(null, "E_OTHER", true)],
      }),
    ).toEqual(FOREIGN);
  });

  test("org install: a flag-less delivery is its own only without a workspace or by its bot", () => {
    // Bolt reads a missing flag as a workspace install: the named workspace's.
    expect(classify(ORG_INSTALL, documentedCommand("T_GRANTED", "E_ORG"))).toEqual(FOREIGN);
    expect(classify(ORG_INSTALL, blockAction({ id: "T_GRANTED" }, "E_ORG"))).toEqual(FOREIGN);
    // No workspace named, or the button sits on the org install's own message.
    expect(classify(ORG_INSTALL, blockAction(null, "E_ORG"))).toEqual(OWN_RESULT);
    expect(
      classify(ORG_INSTALL, blockAction({ id: "T_GRANTED" }, "E_ORG", undefined, "B_ORG")),
    ).toEqual(OWN_RESULT);
    // Enterprise id carried only on team.
    expect(
      classify(ORG_INSTALL, blockAction({ id: "T_GRANTED", enterprise_id: "E_ORG" }, null, true)),
    ).toEqual(OWN_RESULT);
    // The org install's own commands carry the flag, from any workspace of the org.
    const flagged = { ...documentedCommand("T_GRANTED", "E_ORG"), is_enterprise_install: "true" };
    expect(classify(ORG_INSTALL, flagged)).toEqual(OWN_RESULT);
    // Another enterprise or no enterprise.
    expect(classify(ORG_INSTALL, { ...flagged, enterprise_id: "E_OTHER" })).toEqual(FOREIGN);
    expect(classify(ORG_INSTALL, blockAction(null, "E_OTHER"))).toEqual(FOREIGN);
    expect(classify(ORG_INSTALL, documentedCommand("T_GRANTED", null))).toEqual(FOREIGN);
  });

  test("workspace install: flag-less payloads still need its workspace (B3 holds)", () => {
    expect(classify(OWN, documentedCommand("T_OWN", null))).toEqual(OWN_RESULT);
    expect(classify(OWN, blockAction({ id: "T_OWN" }, null))).toEqual(OWN_RESULT);
    expect(classify(GRID_WORKSPACE, documentedCommand("T_SIBLING", "E_ORG"))).toEqual(FOREIGN);
    expect(classify(GRID_WORKSPACE, blockAction(null, "E_ORG"))).toEqual(FOREIGN);
    expect(
      classify(GRID_WORKSPACE, blockAction({ id: "T_SIBLING" }, "E_ORG", undefined, "B_WS")),
    ).toEqual(FOREIGN);
  });

  test("a flag-less delivery in a workspace both installs cover has exactly one owner (B6)", () => {
    // ORG_INSTALL is granted T_OWN, where GRID_WORKSPACE is a workspace install.
    const swarms = [GRID_WORKSPACE, ORG_INSTALL];
    const owners = (body: unknown) => swarms.filter((swarm) => classify(swarm, body).own);
    // A button names the bot that posted its message.
    expect(owners(blockAction({ id: "T_OWN" }, "E_ORG", undefined, "B_WS"))).toEqual([
      GRID_WORKSPACE,
    ]);
    expect(owners(blockAction({ id: "T_OWN" }, "E_ORG", undefined, "B_ORG"))).toEqual([
      ORG_INSTALL,
    ]);
    expect(owners(blockAction({ id: "T_OWN" }, "E_ORG", undefined, "B_SOMEONE_ELSE"))).toEqual([]);
    // A view names the bot that opened it.
    const view = (botId: string) => ({
      type: "view_submission",
      team: { id: "T_OWN", enterprise_id: "E_ORG" },
      view: { id: "V_1", callback_id: "follow_up_submit", bot_id: botId },
    });
    expect(owners(view("B_WS"))).toEqual([GRID_WORKSPACE]);
    expect(owners(view("B_ORG"))).toEqual([ORG_INSTALL]);
    // No bot named: the named workspace's install claims it, as Bolt reads it.
    expect(owners(documentedCommand("T_OWN", "E_ORG"))).toEqual([GRID_WORKSPACE]);
    expect(owners(blockAction({ id: "T_OWN" }, "E_ORG"))).toEqual([GRID_WORKSPACE]);
    // No workspace named: only the org install can own it.
    expect(owners(blockAction(null, "E_ORG"))).toEqual([ORG_INSTALL]);
    // A flagged command goes to the install the flag names.
    const command = (flag: string) => ({
      ...documentedCommand("T_OWN", "E_ORG"),
      is_enterprise_install: flag,
    });
    expect(owners(command("true"))).toEqual([ORG_INSTALL]);
    expect(owners(command("false"))).toEqual([GRID_WORKSPACE]);
    // An explicit flag still decides.
    expect(owners(blockAction({ id: "T_OWN" }, "E_ORG", false))).toEqual([GRID_WORKSPACE]);
    expect(owners(blockAction({ id: "T_OWN" }, "E_ORG", true))).toEqual([ORG_INSTALL]);
    // A message shortcut's message can be anyone's: its bot proves nothing.
    expect(
      readInboundInstallations({
        type: "message_action",
        team: { id: "T_OWN" },
        message: { bot_id: "B_WS" },
      }),
    ).toEqual([{ teamId: "T_OWN", enterpriseId: null, isEnterpriseInstall: null }]);
    // Without a known bot of its own, a swarm claims no bot-named delivery.
    const { botId: _ignored, ...noBot } = GRID_WORKSPACE;
    expect(classify(noBot, blockAction({ id: "T_OWN" }, "E_ORG", undefined, "B_WS"))).toEqual(
      FOREIGN,
    );
  });

  test("a view opened from a Slack Connect channel is attributed to the installing workspace", () => {
    const view = (installedTeam: string) => ({
      type: "view_submission",
      team: { id: "T_PARTNER" },
      is_enterprise_install: false,
      view: { id: "V_1", callback_id: "follow_up_submit", app_installed_team_id: installedTeam },
    });
    expect(classify(OWN, view("T_OWN"))).toEqual(OWN_RESULT);
    expect(classify(OWN, view("T_OTHER"))).toEqual(FOREIGN);
  });
});

describe("identity", () => {
  // The documented auth.test response (docs.slack.dev/reference/methods/auth.test).
  const DOCUMENTED_AUTH_TEST = {
    ok: true,
    url: "https://subarachnoid.slack.com/",
    team: "Subarachnoid Workspace",
    user: "grace",
    team_id: "T12345678",
    user_id: "W12345678",
  };

  test("a documented auth.test response gives a workspace identity", () => {
    expect(identityFromAuthTest(DOCUMENTED_AUTH_TEST, false)).toEqual({
      teamId: "T12345678",
      enterpriseId: null,
      isEnterpriseInstall: false,
    });
    // A bot token's auth.test also names the installation's bot.
    expect(identityFromAuthTest({ ...DOCUMENTED_AUTH_TEST, bot_id: "B12345678" }, false)).toEqual({
      teamId: "T12345678",
      enterpriseId: null,
      isEnterpriseInstall: false,
      botId: "B12345678",
    });
  });

  test("org-wide mode comes from trusted install metadata, never from auth.test", () => {
    const claimsOrgWide = { ...DOCUMENTED_AUTH_TEST, is_enterprise_install: true };
    expect(identityFromAuthTest(claimsOrgWide, false).isEnterpriseInstall).toBe(false);
    expect(identityFromAuthTest({ ...DOCUMENTED_AUTH_TEST, enterprise_id: "E_ORG" }, true)).toEqual(
      { teamId: null, enterpriseId: "E_ORG", isEnterpriseInstall: true },
    );
    expect(isSlackEnterpriseInstall({})).toBe(false);
    expect(isSlackEnterpriseInstall({ SLACK_ENTERPRISE_INSTALL: "true" })).toBe(true);
  });

  test("auth.test without the id the install mode needs is a failed lookup", () => {
    expect(() => identityFromAuthTest(DOCUMENTED_AUTH_TEST, true)).toThrow(/enterprise_id/);
    expect(() => identityFromAuthTest({ enterprise_id: "E_ORG" }, false)).toThrow(/team_id/);
  });

  test("resolved once and cached", async () => {
    let calls = 0;
    setSlackWorkspaceIdentitySource(async () => {
      calls += 1;
      return OWN;
    });
    await Promise.all([getSlackWorkspaceIdentity(), getSlackWorkspaceIdentity()]);
    expect(await getSlackWorkspaceIdentity()).toEqual(OWN);
    expect(getCachedSlackWorkspaceIdentity()).toEqual(OWN);
    expect(calls).toBe(1);
  });

  test("resolveSlackIdentity reads auth.test only, in either install mode", async () => {
    let calls = 0;
    const client = {
      auth: {
        test: async () => {
          calls += 1;
          return { team_id: "T_ANY", enterprise_id: "E_ORG", bot_id: "B_1" };
        },
      },
    };
    expect(await resolveSlackIdentity(client, true)).toEqual({
      teamId: null,
      enterpriseId: "E_ORG",
      isEnterpriseInstall: true,
      botId: "B_1",
    });
    expect(await resolveSlackIdentity(client, false)).toEqual({
      teamId: "T_ANY",
      enterpriseId: "E_ORG",
      isEnterpriseInstall: false,
      botId: "B_1",
    });
    expect(calls).toBe(2);
  });

  test("a failed lookup caches nothing and the next call retries", async () => {
    let calls = 0;
    setSlackWorkspaceIdentitySource(async () => {
      calls += 1;
      if (calls === 1) throw new Error("fatal_error");
      return OWN;
    });
    expect(await getSlackWorkspaceIdentity()).toBeNull();
    expect(getCachedSlackWorkspaceIdentity()).toBeNull();
    expect(await getSlackWorkspaceIdentity()).toEqual(OWN);
    expect(calls).toBe(2);
  });
});

type SocketClient = SocketModeReceiver["client"];

/** A Bolt app wired like app.ts: ack recovery, then the gate, then the middleware. */
function buildSwarm(getIdentity: () => SlackWorkspaceIdentity | null) {
  const receiver = new SocketModeReceiver({ appToken: "xapp-test", logLevel: LogLevel.ERROR });
  const app = new App({
    receiver,
    socketMode: true,
    logLevel: LogLevel.ERROR,
    authorize: async () => ({ botToken: "xoxb-test", botId: "B_TEST", botUserId: "U_BOT" }),
  });
  const drain = installSocketAckRecovery(receiver.client, app);
  installSocketWorkspaceGate(receiver.client, getIdentity);
  const created: string[] = [];
  app.use(slackInboundOutcomeMiddleware());
  // Stands in for the mention handler's task creation.
  app.event("app_mention", async ({ body }) => {
    created.push(body.event_id);
  });
  app.command("/swarm", async ({ ack, body }) => {
    await ack();
    created.push(`command:${body.team_id}`);
  });
  app.action("follow_up_task", async ({ ack, body }) => {
    await ack();
    created.push(`action:${body.team?.id ?? "org"}`);
  });
  return { app, client: receiver.client, created, drain };
}

/** Emit an envelope the way SocketModeClient does; resolve with whether it was acked. */
async function emitEnvelope(
  client: SocketClient,
  type: "events_api" | "slash_commands" | "interactive",
  body: Record<string, unknown>,
): Promise<boolean> {
  let acked = false;
  client.emit("slack_event", {
    ack: async () => {
      acked = true;
    },
    envelope_id: `env-${Math.random().toString(36).slice(2)}`,
    type,
    body,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  return acked;
}

describe("socket gate: before Bolt acks", () => {
  test("a foreign delivery is neither acked nor dispatched", async () => {
    await resolveIdentityFor(OWN);
    const swarm = buildSwarm(() => OWN);
    try {
      expect(await emitEnvelope(swarm.client, "events_api", eventBody("T_OTHER"))).toBe(false);
      expect(
        await emitEnvelope(swarm.client, "slash_commands", { command: "/swarm", team_id: "T_X" }),
      ).toBe(false);
      expect(swarm.created).toEqual([]);

      const own = eventBody("T_OWN");
      expect(await emitEnvelope(swarm.client, "events_api", own)).toBe(true);
      expect(swarm.created).toEqual([own.event_id]);
    } finally {
      swarm.drain.stop();
    }
  });

  test("fails closed until the identity resolves, and the redelivery then passes", async () => {
    // As in app.ts: the gate reads the process-wide identity.
    const swarm = buildSwarm(getCachedSlackWorkspaceIdentity);
    try {
      const body = eventBody("T_OWN");
      expect(await emitEnvelope(swarm.client, "events_api", body)).toBe(false);
      expect(swarm.created).toEqual([]);
      await resolveIdentityFor(OWN);
      expect(await emitEnvelope(swarm.client, "events_api", body)).toBe(true);
      expect(swarm.created).toEqual([body.event_id]);
    } finally {
      swarm.drain.stop();
    }
  });

  test("an envelope with no installation field is withheld", async () => {
    const swarm = buildSwarm(() => OWN);
    try {
      const body = eventBody("T_OWN");
      delete (body as Record<string, unknown>).authorizations;
      expect(await emitEnvelope(swarm.client, "events_api", body)).toBe(false);
      expect(swarm.created).toEqual([]);
    } finally {
      swarm.drain.stop();
    }
  });
});

describe("socket gate: org install buttons and slash commands", () => {
  test("its command and buttons are handled from any workspace, with no lookup per workspace", async () => {
    let lookups = 0;
    setSlackWorkspaceIdentitySource(async () => {
      lookups += 1;
      return ORG_INSTALL;
    });
    await getSlackWorkspaceIdentity();
    const swarm = buildSwarm(getCachedSlackWorkspaceIdentity);
    try {
      // The first interaction from a workspace the swarm has never seen.
      const command = { ...documentedCommand("T_NEW", "E_ORG"), is_enterprise_install: "true" };
      expect(await emitEnvelope(swarm.client, "slash_commands", command)).toBe(true);
      const button = blockAction({ id: "T_NEWER" }, "E_ORG", undefined, "B_ORG");
      expect(await emitEnvelope(swarm.client, "interactive", button)).toBe(true);
      const orgSurface = blockAction(null, "E_ORG");
      expect(await emitEnvelope(swarm.client, "interactive", orgSurface)).toBe(true);
      expect(swarm.created).toEqual(["command:T_NEW", "action:T_NEWER", "action:org"]);
      expect(lookups).toBe(1);
    } finally {
      swarm.drain.stop();
    }
  });

  test("another installation's flag-less command and button are withheld", async () => {
    await resolveIdentityFor(ORG_INSTALL);
    const swarm = buildSwarm(getCachedSlackWorkspaceIdentity);
    try {
      for (const [type, body] of [
        ["slash_commands", documentedCommand("T_GRANTED", "E_OTHER")],
        ["slash_commands", documentedCommand("T_GRANTED", null)],
        ["interactive", blockAction({ id: "T_GRANTED" }, "E_OTHER")],
        ["interactive", blockAction({ id: "T_GRANTED" }, "E_ORG", false)],
        // Flag-less and naming a workspace: that workspace's install's.
        ["slash_commands", documentedCommand("T_GRANTED", "E_ORG")],
      ] as const) {
        expect(await emitEnvelope(swarm.client, type, body)).toBe(false);
      }
      expect(swarm.created).toEqual([]);
    } finally {
      swarm.drain.stop();
    }
  });

  test("a workspace install keeps rejecting a sibling's flag-less command (B3)", async () => {
    await resolveIdentityFor(GRID_WORKSPACE);
    const swarm = buildSwarm(getCachedSlackWorkspaceIdentity);
    try {
      expect(
        await emitEnvelope(swarm.client, "slash_commands", documentedCommand("T_SIBLING", "E_ORG")),
      ).toBe(false);
      expect(await emitEnvelope(swarm.client, "interactive", blockAction(null, "E_ORG"))).toBe(
        false,
      );
      const ownCommand = { ...documentedCommand("T_OWN", "E_ORG"), is_enterprise_install: "false" };
      expect(await emitEnvelope(swarm.client, "slash_commands", ownCommand)).toBe(true);
      expect(swarm.created).toEqual(["command:T_OWN"]);
    } finally {
      swarm.drain.stop();
    }
  });

  test("two swarms covering one workspace: each flag-less delivery reaches exactly one (B6)", async () => {
    for (const [identity, other] of [
      [GRID_WORKSPACE, ORG_INSTALL],
      [ORG_INSTALL, GRID_WORKSPACE],
    ] as const) {
      await resolveIdentityFor(identity);
      const swarm = buildSwarm(getCachedSlackWorkspaceIdentity);
      try {
        const foreign = blockAction({ id: "T_OWN" }, "E_ORG", undefined, other.botId);
        expect(await emitEnvelope(swarm.client, "interactive", foreign)).toBe(false);
        const own = blockAction({ id: "T_OWN" }, "E_ORG", undefined, identity.botId);
        expect(await emitEnvelope(swarm.client, "interactive", own)).toBe(true);
        // A workspace-owned command: the workspace swarm handles it, the org swarm withholds it.
        const workspaceSwarm = identity === GRID_WORKSPACE;
        const command = documentedCommand("T_OWN", "E_ORG");
        expect(await emitEnvelope(swarm.client, "slash_commands", command)).toBe(workspaceSwarm);
        expect(swarm.created).toEqual(
          workspaceSwarm ? ["action:T_OWN", "command:T_OWN"] : ["action:T_OWN"],
        );
      } finally {
        swarm.drain.stop();
      }
    }
  });
});

describe("middleware: deliveries that reach Bolt another way", () => {
  test("a receipt replayed before the identity resolved fails retryably", async () => {
    const swarm = buildSwarm(() => null);
    try {
      const outcome = await runAdmittedSlackDelivery(
        "socket",
        () => swarm.app.processEvent({ body: eventBody("T_OWN"), ack: async () => {} }),
        { requireBoltDispatch: true },
      );
      expect(outcome).toEqual({ state: "failed", code: "workspace_identity_unavailable" });
      expect(swarm.created).toEqual([]);
    } finally {
      swarm.drain.stop();
    }
  });

  test("a replayed receipt from another workspace resolves to ignored", async () => {
    await resolveIdentityFor(OWN);
    const swarm = buildSwarm(() => OWN);
    try {
      const outcome = await runAdmittedSlackDelivery(
        "socket",
        () => swarm.app.processEvent({ body: eventBody("T_OTHER"), ack: async () => {} }),
        { requireBoltDispatch: true },
      );
      expect(outcome).toEqual({ state: "ignored", code: "foreign_workspace" });
      expect(swarm.created).toEqual([]);
    } finally {
      swarm.drain.stop();
    }
  });

  test("an own live delivery passes; an unattributable one is ignored", async () => {
    await resolveIdentityFor(OWN);
    const swarm = buildSwarm(() => OWN);
    try {
      const own = eventBody("T_OWN");
      await swarm.app.processEvent({ body: own, ack: async () => {} });
      await swarm.app.processEvent({
        body: { ...eventBody("T_OWN"), authorizations: [] },
        ack: async () => {},
      });
      expect(swarm.created).toEqual([own.event_id]);
      const { outcomes } = await getSlackInboundDiagnostics();
      expect(outcomes.socket.processed).toBe(1);
      expect(outcomes.socket.ignored).toBe(1);
    } finally {
      swarm.drain.stop();
    }
  });
});

describe("over a shared Slack app (slack-mock)", () => {
  const SLACK_ENV_KEYS = [
    "NODE_ENV",
    "SLACK_MODE",
    "SLACK_DISABLE",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_API_URL",
    "SLACK_ENTERPRISE_INSTALL",
    "SLACK_RENDER_V2",
  ] as const;
  const savedEnv = new Map(SLACK_ENV_KEYS.map((key) => [key, process.env[key]]));
  let slack: SlackHarness;

  beforeEach(async () => {
    slack = await startSlackMock(false);
    for (const key of SLACK_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, slack.mock.env, {
      NODE_ENV: "test",
      SLACK_DISABLE: "false",
      SLACK_RENDER_V2: "false",
    });
  });

  afterEach(async () => {
    await stopSlackApp();
    setSlackStartRetryDelaysForTests(null);
    await stopSlackMock(slack, false);
    for (const key of SLACK_ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("startup with a failed auth.test opens no socket, then retries and connects", async () => {
    setSlackStartRetryDelaysForTests([150]);
    // Bolt's own auth.test at construction and the guard's lookup both fail.
    slack.mock.injectFault({ method: "auth.test", error: "fatal_error", times: 2 });

    expect(await startSlackApp()).toBe(false);
    expect(slack.mock.apiCalls("apps.connections.open")).toHaveLength(0);
    expect(getSlackConnectionState()).toBe("disconnected");
    expect(getCachedSlackWorkspaceIdentity()).toBeNull();

    // The retry rebuilds the app, resolves the identity, then opens the socket.
    await slack.mock.waitForConnection(10_000);
    expect(slack.mock.apiCalls("apps.connections.open")).toHaveLength(1);
    expect(getCachedSlackWorkspaceIdentity()?.teamId).toBe(slack.mock.team.id);
  }, 20_000);

  test("stopSlackApp cancels a pending start retry", async () => {
    setSlackStartRetryDelaysForTests([150]);
    slack.mock.injectFault({ method: "auth.test", error: "fatal_error", times: 2 });
    expect(await startSlackApp()).toBe(false);
    await stopSlackApp();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(slack.mock.apiCalls("apps.connections.open")).toHaveLength(0);
  }, 20_000);

  test("two swarms on one app: a withheld mention is redelivered, never handled by the other", async () => {
    await slack.mock.stop();
    // Short ack timeout so a withheld envelope is redelivered quickly.
    slack = {
      mock: await SlackMock.start({
        port: 0,
        manifest: `${repoRoot}/slack-manifest.json`,
        ackTimeoutMs: 200,
        maxRetries: 3,
      }),
    };
    const env = slack.mock.env;
    const owner = { teamId: slack.mock.team.id, enterpriseId: null, isEnterpriseInstall: false };
    const other = { teamId: "T_OTHER_SWARM", enterpriseId: null, isEnterpriseInstall: false };
    // The middleware reads the process-wide identity; each swarm's gate gets its own.
    await resolveIdentityFor(owner);

    const swarms = [owner, other].map((identity) => {
      const receiver = new SocketModeReceiver({
        appToken: env.SLACK_APP_TOKEN!,
        logLevel: LogLevel.ERROR,
        installerOptions: { clientOptions: { slackApiUrl: env.SLACK_API_URL } },
      });
      const app = new App({
        token: env.SLACK_BOT_TOKEN,
        receiver,
        socketMode: true,
        logLevel: LogLevel.ERROR,
        clientOptions: { slackApiUrl: env.SLACK_API_URL },
      });
      installSocketWorkspaceGate(receiver.client, () => identity);
      const seen: string[] = [];
      app.use(slackInboundOutcomeMiddleware());
      app.message(async ({ message }) => {
        seen.push((message as { ts: string }).ts);
      });
      return { app, seen };
    });

    try {
      for (const swarm of swarms) await swarm.app.start();
      for (let i = 0; i < 20 && slack.mock.connectionCount < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(slack.mock.connectionCount).toBe(2);

      const posted: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const message = await slack.mock.postMessage({ channel: "general", text: `ask ${i}` });
        posted.push(message.ts);
      }
      const settled = Date.now() + 8_000;
      while (swarms[0]!.seen.length < posted.length && Date.now() < settled) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect([...swarms[0]!.seen].sort()).toEqual([...posted].sort());
      expect(swarms[1]!.seen).toEqual([]);
      const deliveries = slack.mock.deliveries().filter((d) => d.type === "events_api");
      expect(deliveries.every((d) => d.acked)).toBe(true);
      // Some first attempts landed on the other swarm and were redelivered, not lost.
      expect(deliveries.some((d) => d.attempts > 1)).toBe(true);
    } finally {
      for (const swarm of swarms) await swarm.app.stop();
    }
  }, 30_000);
});
