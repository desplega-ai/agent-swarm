/**
 * Inbound workspace guard: a Slack app shared by several swarms delivers every
 * workspace's events to every swarm's socket. Deliveries from another workspace
 * must stop at the first middleware, before any listener creates a task.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { App, LogLevel, SocketModeReceiver } from "@slack/bolt";
import { closeDb, initDb } from "../be/db";
import {
  getSlackInboundDiagnostics,
  resetSlackInboundCountersForTests,
  runAdmittedSlackDelivery,
  slackInboundOutcomeMiddleware,
} from "../slack/inbound-dispatch";
import {
  checkInboundWorkspace,
  getSlackWorkspaceIdentity,
  IDENTITY_RETRY_MS,
  matchInboundWorkspace,
  readInboundWorkspaceIds,
  resetSlackWorkspaceGuardForTests,
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

function eventBody(teamId: string, extra: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: teamId,
    api_app_id: "A_SHARED",
    event_id: `Ev_${teamId}_${Math.random().toString(36).slice(2)}`,
    authorizations: [{ team_id: teamId, enterprise_id: null, is_enterprise_install: false }],
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

describe("readInboundWorkspaceIds", () => {
  test("Events API: authorizations win over the top-level team_id", () => {
    // Slack Connect: the top-level team can be the partner workspace.
    const ids = readInboundWorkspaceIds({
      team_id: "T_PARTNER",
      authorizations: [{ team_id: "T_OWN", enterprise_id: "E_1" }],
    });
    expect(ids).toEqual({ teamIds: ["T_OWN"], enterpriseIds: ["E_1"] });
  });

  test("interactive, view and shortcut payloads: team.id and enterprise.id", () => {
    expect(
      readInboundWorkspaceIds({
        type: "block_actions",
        team: { id: "T_A" },
        enterprise: { id: "E_A" },
      }),
    ).toEqual({ teamIds: ["T_A"], enterpriseIds: ["E_A"] });
  });

  test("slash commands: team_id and enterprise_id", () => {
    expect(
      readInboundWorkspaceIds({ command: "/swarm", team_id: "T_A", enterprise_id: "E_A" }),
    ).toEqual({ teamIds: ["T_A"], enterpriseIds: ["E_A"] });
  });

  test("payload with no workspace field", () => {
    expect(readInboundWorkspaceIds({ type: "event_callback", event: {} })).toEqual({
      teamIds: [],
      enterpriseIds: [],
    });
    expect(readInboundWorkspaceIds(undefined)).toEqual({ teamIds: [], enterpriseIds: [] });
    expect(readInboundWorkspaceIds({ team: null, authorizations: [] })).toEqual({
      teamIds: [],
      enterpriseIds: [],
    });
  });
});

describe("matchInboundWorkspace", () => {
  test("own and foreign workspace", () => {
    expect(matchInboundWorkspace(OWN, { teamIds: ["T_OWN"], enterpriseIds: [] })).toBe("own");
    expect(matchInboundWorkspace(OWN, { teamIds: ["T_OTHER"], enterpriseIds: [] })).toBe("foreign");
  });

  test("no workspace field is unknown, never foreign", () => {
    expect(matchInboundWorkspace(OWN, { teamIds: [], enterpriseIds: [] })).toBe("unknown");
  });

  test("a workspace install in a Grid org matches on the workspace, not the org", () => {
    const gridWorkspace = { teamId: "T_OWN", enterpriseId: "E_ORG", isEnterpriseInstall: false };
    expect(
      matchInboundWorkspace(gridWorkspace, { teamIds: ["T_SIBLING"], enterpriseIds: ["E_ORG"] }),
    ).toBe("foreign");
    // Org-level payload with no workspace: ours only inside our org.
    expect(matchInboundWorkspace(gridWorkspace, { teamIds: [], enterpriseIds: ["E_ORG"] })).toBe(
      "own",
    );
    expect(matchInboundWorkspace(gridWorkspace, { teamIds: [], enterpriseIds: ["E_OTHER"] })).toBe(
      "foreign",
    );
  });

  test("org-wide Enterprise install matches on enterprise_id", () => {
    const orgInstall = { teamId: "E_ORG", enterpriseId: "E_ORG", isEnterpriseInstall: true };
    expect(
      matchInboundWorkspace(orgInstall, { teamIds: ["T_ANY_WORKSPACE"], enterpriseIds: ["E_ORG"] }),
    ).toBe("own");
    expect(
      matchInboundWorkspace(orgInstall, { teamIds: ["T_ANY_WORKSPACE"], enterpriseIds: ["E_X"] }),
    ).toBe("foreign");
    expect(matchInboundWorkspace(orgInstall, { teamIds: ["T_ANY"], enterpriseIds: [] })).toBe(
      "unknown",
    );
  });
});

describe("workspace identity", () => {
  test("no source registered: nothing is checked", async () => {
    expect(await getSlackWorkspaceIdentity()).toBeNull();
    expect(await checkInboundWorkspace(eventBody("T_OTHER"))).toBeNull();
  });

  test("auth.test is called once and cached", async () => {
    let calls = 0;
    setSlackWorkspaceIdentitySource(async () => {
      calls += 1;
      return { team_id: "T_OWN", is_enterprise_install: false };
    });
    await Promise.all([getSlackWorkspaceIdentity(), getSlackWorkspaceIdentity()]);
    expect(await getSlackWorkspaceIdentity()).toEqual(OWN);
    expect(calls).toBe(1);
  });

  test("a failed auth.test lets deliveries through and retries after the backoff", async () => {
    let calls = 0;
    setSlackWorkspaceIdentitySource(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ratelimited");
      return { team_id: "T_OWN" };
    });
    expect(await checkInboundWorkspace(eventBody("T_OTHER"))).toBeNull();
    expect(await getSlackWorkspaceIdentity(Date.now() + 1)).toBeNull();
    expect(calls).toBe(1);
    expect(await getSlackWorkspaceIdentity(Date.now() + IDENTITY_RETRY_MS + 1)).toEqual(OWN);
    expect(await checkInboundWorkspace(eventBody("T_OTHER"))).toBe("foreign_workspace");
  });
});

describe("through Bolt's first middleware", () => {
  function buildApp() {
    const receiver = new SocketModeReceiver({ appToken: "xapp-test", logLevel: LogLevel.ERROR });
    const app = new App({
      receiver,
      socketMode: true,
      logLevel: LogLevel.ERROR,
      authorize: async () => ({ botToken: "xoxb-test", botId: "B_TEST", botUserId: "U_BOT" }),
    });
    const created: string[] = [];
    const acks: string[] = [];
    app.use(slackInboundOutcomeMiddleware());
    // Stands in for the mention handler's task creation.
    app.event("app_mention", async ({ body }) => {
      created.push((body as { team_id: string }).team_id);
    });
    app.command("/swarm", async ({ ack, body }) => {
      await ack();
      created.push(`command:${body.team_id}`);
    });
    app.action("follow_up", async ({ ack, body }) => {
      await ack();
      created.push(`action:${body.team?.id}`);
    });
    const deliver = (body: Record<string, unknown>, label = "event") =>
      app.processEvent({
        body,
        ack: async () => {
          acks.push(label);
        },
      });
    return { app, created, acks, deliver };
  }

  beforeEach(() => {
    setSlackWorkspaceIdentitySource(async () => ({ team_id: "T_OWN" }));
  });

  test("a foreign workspace's mention is acked and dropped before task creation", async () => {
    const { created, acks, deliver } = buildApp();
    await deliver(eventBody("T_OTHER"));
    expect(created).toEqual([]);
    // Bolt acks Events API envelopes before middleware: no Slack retry storm.
    expect(acks).toEqual(["event"]);
    const { outcomes } = await getSlackInboundDiagnostics();
    expect(outcomes.socket.ignored).toBe(1);
    expect(outcomes.socket.processed).toBe(0);
  });

  test("the own workspace's mention passes", async () => {
    const { created, deliver } = buildApp();
    await deliver(eventBody("T_OWN"));
    expect(created).toEqual(["T_OWN"]);
    const { outcomes } = await getSlackInboundDiagnostics();
    expect(outcomes.socket.processed).toBe(1);
    expect(outcomes.socket.ignored).toBe(0);
  });

  test("a payload with no workspace field passes", async () => {
    const { created, deliver } = buildApp();
    const body = eventBody("T_OWN");
    delete (body as Record<string, unknown>).team_id;
    delete (body as Record<string, unknown>).authorizations;
    await deliver(body);
    expect(created).toEqual([undefined as unknown as string]);
  });

  test("foreign slash commands and block actions are dropped and left unacked", async () => {
    const { created, acks, deliver } = buildApp();
    await deliver(
      { command: "/swarm", team_id: "T_OTHER", text: "x", user_id: "U_1", channel_id: "C_1" },
      "command",
    );
    await deliver(
      {
        type: "block_actions",
        team: { id: "T_OTHER" },
        user: { id: "U_1" },
        actions: [{ action_id: "follow_up", type: "button" }],
      },
      "action",
    );
    expect(created).toEqual([]);
    expect(acks).toEqual([]);

    await deliver(
      { command: "/swarm", team_id: "T_OWN", text: "x", user_id: "U_1", channel_id: "C_1" },
      "command",
    );
    expect(created).toEqual(["command:T_OWN"]);
    expect(acks).toEqual(["command"]);
  });

  test("Enterprise org install: any workspace of the org passes, other orgs drop", async () => {
    setSlackWorkspaceIdentitySource(async () => ({
      team_id: "E_ORG",
      enterprise_id: "E_ORG",
      is_enterprise_install: true,
    }));
    const { created, deliver } = buildApp();
    const inOrg = eventBody("T_WS1", {
      enterprise_id: "E_ORG",
      authorizations: [{ team_id: null, enterprise_id: "E_ORG", is_enterprise_install: true }],
    });
    const otherOrg = eventBody("T_WS2", {
      enterprise_id: "E_OTHER",
      authorizations: [{ team_id: null, enterprise_id: "E_OTHER", is_enterprise_install: true }],
    });
    await deliver(inOrg);
    await deliver(otherOrg);
    expect(created).toEqual(["T_WS1"]);
  });

  test("a durable (receipt) delivery from another workspace resolves to ignored", async () => {
    const { app, created } = buildApp();
    const outcome = await runAdmittedSlackDelivery(
      "socket",
      () => app.processEvent({ body: eventBody("T_OTHER"), ack: async () => {} }),
      { requireBoltDispatch: true },
    );
    expect(outcome).toEqual({ state: "ignored", code: "foreign_workspace" });
    expect(created).toEqual([]);
  });
});
