import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { applyAppDefinitionPatch, parseAppDefinition } from "../apps/definition";
import { getApp } from "../apps/store";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { handleApps } from "../http/apps";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = `/private/tmp/test-apps-elements-${process.pid}.sqlite`;
const AGENT_ID = crypto.randomUUID();
let server: Server;
let base = "";

const emptyPage = {
  root: "root",
  elements: { root: { type: "Container", props: {} } },
};

function baseDefinition() {
  return {
    models: {
      note: {
        columns: {
          title: { kind: "string" },
        },
      },
    },
    queries: { allNotes: { model: "note" } },
    actions: { archive: { kind: "task", prompt: "Archive the selected note" } },
    pages: { main: structuredClone(emptyPage) },
    defaultPage: "main",
  };
}

function pureElement(exported = false, withSlot = true) {
  return {
    mode: "pure",
    ...(exported ? { export: true } : {}),
    props: { label: { kind: "string", required: true } },
    root: "root",
    elements: {
      root: {
        type: "Stack",
        props: {},
        children: withSlot ? ["label", "slot"] : ["label"],
      },
      label: { type: "Text", props: { content: { $state: "/props/label" } } },
      ...(withSlot ? { slot: { type: "ElementSlot", props: {} } } : {}),
    },
  };
}

function boundElement(query = "allNotes") {
  return {
    mode: "bound",
    root: "table",
    elements: {
      table: {
        type: "Table",
        props: {
          data: { $state: `/queries/${query}/data` },
          columns: [{ key: "title" }],
        },
        on: {
          select: { action: "app.action", params: { name: "archive" } },
        },
      },
    },
  };
}

function refPage(appId: string | undefined, element: string, props: unknown = {}) {
  return {
    root: "ref",
    elements: {
      ref: {
        type: "ElementRef",
        props: {
          ...(appId ? { app: appId } : {}),
          element,
          props,
          instanceKey: "fixture",
        },
      },
    },
  };
}

function exportedRefElement(appId: string, element: string) {
  return {
    mode: "pure" as const,
    export: true,
    root: "ref",
    elements: {
      ref: { type: "ElementRef", props: { app: appId, element, props: {} } },
    },
  };
}

function fanoutDefinition(fanout: number, levels = 8) {
  const elements: Record<string, unknown> = {};
  for (let level = 1; level <= levels; level += 1) {
    const name = `level${level}`;
    if (level === levels) {
      elements[name] = {
        mode: "pure",
        root: "text",
        elements: { text: { type: "Text", props: { content: "end" } } },
      };
      continue;
    }
    const children = Array.from({ length: fanout }, (_, index) => `ref${index}`);
    elements[name] = {
      mode: "pure",
      root: "root",
      elements: {
        root: { type: "Stack", props: {}, children },
        ...Object.fromEntries(
          children.map((id) => [
            id,
            {
              type: "ElementRef",
              props: { element: `level${level + 1}`, props: {} },
            },
          ]),
        ),
      },
    };
  }
  return {
    ...baseDefinition(),
    elements,
    pages: { main: refPage(undefined, "level1") },
  };
}

function replaceStoredDefinition(appId: string, definition: unknown): void {
  getDb()
    .prepare("UPDATE apps SET definition = ? WHERE id = ?")
    .run(JSON.stringify(definition), appId);
}

async function deleteTestDatabase(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(`${TEST_DB_PATH}${suffix}`)
      .delete()
      .catch(() => undefined);
  }
}

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleApps(req, res, pathSegments, queryParams, myAgentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": AGENT_ID,
      ...init.headers,
    },
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function createApp(
  definition: unknown = baseDefinition(),
  name = "Elements fixture",
): Promise<{ status: number; id?: string; issues?: Array<{ path: string; message: string }> }> {
  const result = await request<{
    app?: { id: string };
    issues?: Array<{ path: string; message: string }>;
  }>("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name, definition }),
  });
  return { status: result.status, id: result.body.app?.id, issues: result.body.issues };
}

function expectParseIssue(definition: unknown, message: string): void {
  const parsed = parseAppDefinition(definition);
  expect(parsed.success).toBe(false);
  if (parsed.success) return;
  expect(parsed.issues.some((entry) => entry.message.includes(message))).toBe(true);
}

beforeAll(async () => {
  await deleteTestDatabase();
  initDb(TEST_DB_PATH);
  createAgent({ id: AGENT_ID, name: "apps-elements-worker", isLead: false, status: "idle" });
  server = createTestServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  getDb().run("DELETE FROM kv_entries WHERE namespace LIKE 'apps:%'");
  getDb().run("DELETE FROM apps");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await deleteTestDatabase();
});

describe("reusable app elements", () => {
  test("validates pure and bound modes against their allowed state and action surfaces", () => {
    const valid = {
      ...baseDefinition(),
      elements: { pureCard: pureElement(), recentNotes: boundElement() },
    };
    expect(parseAppDefinition(valid).success).toBe(true);

    const escapedPure = structuredClone(valid);
    escapedPure.elements.pureCard.elements.label.props.content = {
      $state: "/queries/allNotes/data",
    };
    expectParseIssue(escapedPure, "pure element state reference");

    const actingPure = structuredClone(valid);
    actingPure.elements.pureCard.elements.label.on = {
      press: { action: "app.action", params: { name: "archive" } },
    };
    expectParseIssue(actingPure, "pure elements cannot invoke actions");

    const sdkPure = structuredClone(valid);
    sdkPure.elements.pureCard.elements.label.on = {
      press: {
        action: "swarm.sdk",
        params: { sdk: "createTask", args: { description: "not allowed" } },
      },
    };
    expectParseIssue(sdkPure, "pure elements cannot invoke actions");

    const missingBoundQuery = structuredClone(valid);
    missingBoundQuery.elements.recentNotes = boundElement("missing");
    expectParseIssue(missingBoundQuery, 'unknown query "missing"');

    const repeatedPure = structuredClone(valid);
    repeatedPure.elements.pureCard.props.items = { kind: "string" };
    repeatedPure.elements.pureCard.elements.root.repeat = {
      items: { $state: "/props/items" },
    };
    repeatedPure.elements.pureCard.elements.label.props.content = { $item: "label" };
    expect(parseAppDefinition(repeatedPure).success).toBe(true);

    const unscopedRepeatBinding = structuredClone(valid);
    unscopedRepeatBinding.elements.pureCard.elements.label.props.content = { $item: "label" };
    expectParseIssue(unscopedRepeatBinding, "only allowed inside a repeated element");

    const cyclicRepeatBindings = structuredClone(valid);
    cyclicRepeatBindings.elements.pureCard.elements.root.props.gap = { $index: true };
    cyclicRepeatBindings.elements.pureCard.elements.label.props.content = { $item: "label" };
    cyclicRepeatBindings.elements.pureCard.elements.label.children = ["root"];
    const cyclicResult = parseAppDefinition(cyclicRepeatBindings);
    expect(cyclicResult.success).toBe(false);
    if (!cyclicResult.success) {
      expect(cyclicResult.issues.some((entry) => entry.message.includes("cycle references"))).toBe(
        true,
      );
      expect(
        cyclicResult.issues.some((entry) =>
          entry.message.includes("only allowed inside a repeated element"),
        ),
      ).toBe(true);
    }

    const requiredNavigation = structuredClone(valid);
    requiredNavigation.pages.detail = {
      ...structuredClone(emptyPage),
      params: { id: { kind: "string", required: true } },
    };
    requiredNavigation.elements.recentNotes.elements.table.on = {
      select: { action: "app.navigate", params: { page: "detail" } },
    };
    expectParseIssue(requiredNavigation, 'required param "id" is missing');

    const unknownNavigation = structuredClone(requiredNavigation);
    unknownNavigation.elements.recentNotes.elements.table.on.select.params.page = "missing";
    expectParseIssue(unknownNavigation, 'unknown page "missing"');

    const privateNavigation = structuredClone(valid);
    privateNavigation.pages.detail = structuredClone(emptyPage);
    privateNavigation.elements.recentNotes.elements.table.on = {
      select: { action: "app.navigate", params: { page: "detail" } },
    };
    expect(parseAppDefinition(privateNavigation).success).toBe(true);

    const exportedNavigation = structuredClone(privateNavigation);
    exportedNavigation.elements.recentNotes.export = true;
    expectParseIssue(exportedNavigation, "exported bound elements cannot use app.navigate");
  });

  test("enforces ElementSlot cardinality and ElementRef child-slot contracts", async () => {
    const twoSlots = {
      ...baseDefinition(),
      elements: {
        bad: {
          mode: "pure",
          root: "root",
          elements: {
            root: { type: "Stack", props: {}, children: ["one", "two"] },
            one: { type: "ElementSlot", props: {} },
            two: { type: "ElementSlot", props: {} },
          },
        },
      },
    };
    expectParseIssue(twoSlots, "at most one ElementSlot");

    const pageSlot = {
      ...baseDefinition(),
      pages: { main: { root: "slot", elements: { slot: { type: "ElementSlot", props: {} } } } },
    };
    expectParseIssue(pageSlot, "only allowed inside a pure reusable element");

    const boundSlot = {
      ...baseDefinition(),
      elements: {
        bad: {
          mode: "bound",
          root: "slot",
          elements: { slot: { type: "ElementSlot", props: {} } },
        },
      },
    };
    expectParseIssue(boundSlot, "only allowed inside a pure reusable element");

    const nonLeafSlot = {
      ...baseDefinition(),
      elements: {
        bad: {
          mode: "pure",
          root: "slot",
          elements: {
            slot: { type: "ElementSlot", props: {}, children: ["child"] },
            child: { type: "Text", props: { content: "child" } },
          },
        },
      },
    };
    const nonLeafResult = parseAppDefinition(nonLeafSlot);
    expect(nonLeafResult.success).toBe(false);
    if (!nonLeafResult.success) {
      expect(
        nonLeafResult.issues.filter((entry) => entry.message === "ElementSlot must be a leaf"),
      ).toHaveLength(1);
      expect(
        nonLeafResult.issues.some((entry) => entry.message.includes("does not accept children")),
      ).toBe(false);
    }

    const emptyChildrenSlot = structuredClone(nonLeafSlot);
    emptyChildrenSlot.elements.bad.elements.slot.children = [];
    delete emptyChildrenSlot.elements.bad.elements.child;
    const emptyChildrenResult = parseAppDefinition(emptyChildrenSlot);
    expect(emptyChildrenResult.success).toBe(true);

    const targetDefinition = {
      ...baseDefinition(),
      elements: { noSlot: pureElement(true, false) },
    };
    const target = await createApp(targetDefinition, "No-slot library");
    expect(target.status).toBe(201);

    const consumerDefinition = {
      ...baseDefinition(),
      pages: {
        main: {
          root: "ref",
          elements: {
            ref: {
              type: "ElementRef",
              props: { app: target.id, element: "noSlot", props: { label: "hello" } },
              children: ["child"],
            },
            child: { type: "Text", props: { content: "child" } },
          },
        },
      },
    };
    const consumer = await createApp(consumerDefinition, "Slot consumer");
    expect(consumer.status).toBe(400);
    expect(consumer.issues?.some((entry) => entry.message.includes("has no ElementSlot"))).toBe(
      true,
    );
  });

  test("validates same-app and cross-app references, exports, and prop types", async () => {
    const sameApp = {
      ...baseDefinition(),
      elements: { card: pureElement() },
      pages: { main: refPage(undefined, "card", { label: "same app" }) },
    };
    expect(parseAppDefinition(sameApp).success).toBe(true);

    const missing = structuredClone(sameApp);
    missing.pages.main.elements.ref.props.element = "missing";
    const missingResult = parseAppDefinition(missing);
    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      const missingIssue = missingResult.issues.find((entry) =>
        entry.message.includes('element "missing" not found'),
      );
      expect(missingIssue?.message).toBe('element "missing" not found');
      expect(missingIssue?.message).not.toContain("$self");
    }

    const dynamicElement = structuredClone(sameApp) as unknown as {
      pages: { main: { elements: { ref: { props: { element: unknown } } } } };
    };
    dynamicElement.pages.main.elements.ref.props.element = { $state: "/ui/element/value" };
    expectParseIssue(dynamicElement, "element and app must be literal strings");

    const dynamicApp = structuredClone(sameApp) as unknown as {
      pages: { main: { elements: { ref: { props: { app?: unknown } } } } };
    };
    dynamicApp.pages.main.elements.ref.props.app = { $state: "/ui/app/value" };
    expectParseIssue(dynamicApp, "element and app must be literal strings");

    const validBinding = {
      ...baseDefinition(),
      elements: { card: pureElement() },
      pages: {
        main: refPage(undefined, "card", { label: { $state: "/queries/allNotes/data" } }),
      },
    };
    expect(parseAppDefinition(validBinding).success).toBe(true);

    for (const malformed of [
      { $bogus: "ignored" },
      { $bindState: "/queries/allNotes/data" },
      { $bindItem: "label" },
      { $state: 42 },
      { $state: "/queries/allNotes/data", extra: true },
      { $item: "label", extra: true },
      { $index: true, extra: true },
    ]) {
      expectParseIssue(
        {
          ...baseDefinition(),
          elements: { card: pureElement() },
          pages: { main: refPage(undefined, "card", { label: malformed }) },
        },
        "must be a string value or a binding",
      );
    }

    const libraryDefinition = {
      ...baseDefinition(),
      elements: { card: pureElement(false) },
    };
    const library = await createApp(libraryDefinition, "Private library");
    expect(library.status).toBe(201);

    const privateConsumer = {
      ...baseDefinition(),
      pages: { main: refPage(library.id, "card", { label: "private" }) },
    };
    const privateResult = await createApp(privateConsumer, "Private consumer");
    expect(privateResult.status).toBe(400);
    expect(privateResult.issues?.some((entry) => entry.message.includes("is private"))).toBe(true);

    const exportedDefinition = structuredClone(libraryDefinition);
    exportedDefinition.elements.card.export = true;
    const exported = await request(`/api/apps/${library.id}`, {
      method: "PUT",
      body: JSON.stringify({ definition: exportedDefinition }),
    });
    expect(exported.status).toBe(200);

    const badProp = {
      ...baseDefinition(),
      pages: { main: refPage(library.id, "card", { label: 42 }) },
    };
    const badPropResult = await createApp(badProp, "Bad prop consumer");
    expect(badPropResult.status).toBe(400);
    expect(badPropResult.issues?.some((entry) => entry.message.includes("must be a string"))).toBe(
      true,
    );

    const missingProp = {
      ...baseDefinition(),
      pages: { main: refPage(library.id, "card") },
    };
    const missingPropResult = await createApp(missingProp, "Missing prop consumer");
    expect(missingPropResult.status).toBe(400);
    expect(missingPropResult.issues?.some((entry) => entry.message.includes("required prop"))).toBe(
      true,
    );

    const validConsumer = await createApp(
      { ...baseDefinition(), pages: { main: refPage(library.id, "card", { label: "valid" }) } },
      "Valid consumer",
    );
    expect(validConsumer.status).toBe(201);

    const unexported = structuredClone(exportedDefinition);
    delete unexported.elements.card.export;
    const unexportBlocked = await request<{ issues: Array<{ message: string }> }>(
      `/api/apps/${library.id}`,
      { method: "PUT", body: JSON.stringify({ definition: unexported }) },
    );
    expect(unexportBlocked.status).toBe(400);
    expect(unexportBlocked.body.issues[0]?.message).toContain("made private");

    const modeChanged = structuredClone(exportedDefinition);
    modeChanged.elements.card = { ...pureElement(true, false), mode: "bound" };
    const modeBlocked = await request<{ issues: Array<{ message: string }> }>(
      `/api/apps/${library.id}`,
      { method: "PUT", body: JSON.stringify({ definition: modeChanged }) },
    );
    expect(modeBlocked.status).toBe(400);
    expect(modeBlocked.body.issues[0]?.message).toContain("mode changed from pure to bound");

    const kindChanged = structuredClone(exportedDefinition);
    kindChanged.elements.card.props.label.kind = "number";
    const kindBlocked = await request<{ issues: Array<{ message: string }> }>(
      `/api/apps/${library.id}`,
      { method: "PUT", body: JSON.stringify({ definition: kindChanged }) },
    );
    expect(kindBlocked.status).toBe(400);
    expect(kindBlocked.body.issues[0]?.message).toContain(
      "changed prop kinds: label (string to number)",
    );

    const requiredAdded = structuredClone(exportedDefinition);
    requiredAdded.elements.card.props.mustProvide = { kind: "boolean", required: true };
    const requiredBlocked = await request<{ issues: Array<{ message: string }> }>(
      `/api/apps/${library.id}`,
      { method: "PUT", body: JSON.stringify({ definition: requiredAdded }) },
    );
    expect(requiredBlocked.status).toBe(400);
    expect(requiredBlocked.body.issues[0]?.message).toContain(
      "added required props without defaults: mustProvide",
    );

    const additive = structuredClone(exportedDefinition);
    additive.elements.card.props.tone = { kind: "string" };
    const additiveResult = await request(`/api/apps/${library.id}`, {
      method: "PUT",
      body: JSON.stringify({ definition: additive }),
    });
    expect(additiveResult).toMatchObject({ status: 200 });

    const propRemovalBlocked = await request<{ issues: Array<{ message: string }> }>(
      `/api/apps/${library.id}`,
      { method: "PUT", body: JSON.stringify({ definition: exportedDefinition }) },
    );
    expect(propRemovalBlocked.status).toBe(400);
    expect(propRemovalBlocked.body.issues[0]?.message).toContain("removed props: tone");
  });

  test("rejects recursive references and reference chains deeper than five", () => {
    const cyclic = {
      ...baseDefinition(),
      elements: {
        first: {
          mode: "pure",
          root: "ref",
          elements: {
            ref: { type: "ElementRef", props: { element: "second", props: {} } },
          },
        },
        second: {
          mode: "pure",
          root: "ref",
          elements: {
            ref: { type: "ElementRef", props: { element: "first", props: {} } },
          },
        },
      },
      pages: { main: refPage(undefined, "first") },
    };
    const cyclicResult = parseAppDefinition(cyclic);
    expect(cyclicResult.success).toBe(false);
    if (!cyclicResult.success) {
      const cycleIssue = cyclicResult.issues.find((entry) =>
        entry.message.includes("recursive element reference cycle"),
      );
      expect(cycleIssue?.message).toMatch(
        /^recursive element reference cycle reaches "(?:first|second)"$/,
      );
      expect(cycleIssue?.message).not.toContain("$self");
    }

    const elements: Record<string, unknown> = {};
    for (let index = 1; index <= 6; index += 1) {
      elements[`level${index}`] =
        index === 6
          ? {
              mode: "pure",
              root: "text",
              elements: { text: { type: "Text", props: { content: "end" } } },
            }
          : {
              mode: "pure",
              root: "ref",
              elements: {
                ref: {
                  type: "ElementRef",
                  props: { element: `level${index + 1}`, props: {} },
                },
              },
            };
    }
    expectParseIssue(
      { ...baseDefinition(), elements, pages: { main: refPage(undefined, "level1") } },
      "maximum depth of 5",
    );
  });

  test("bounds reference expansion work and caps reusable element node maps", () => {
    const startedAt = performance.now();
    const fanout = parseAppDefinition(fanoutDefinition(8));
    const durationMs = performance.now() - startedAt;
    expect(durationMs).toBeLessThan(1_000);
    expect(fanout.success).toBe(false);
    if (!fanout.success) {
      expect(fanout.issues.length).toBeLessThanOrEqual(101);
      expect(
        fanout.issues.filter((entry) =>
          entry.message.includes("element reference expansion exceeded budget"),
        ),
      ).toHaveLength(1);
    }

    const tooManyNodes = {
      ...baseDefinition(),
      elements: {
        huge: {
          mode: "pure",
          root: "node0",
          elements: Object.fromEntries(
            Array.from({ length: 151 }, (_, index) => [
              `node${index}`,
              {
                type: "Stack",
                props: {},
                children: index === 150 ? [] : [`node${index + 1}`],
              },
            ]),
          ),
        },
      },
    };
    expectParseIssue(tooManyNodes, "must contain at most 150 nodes");
  });

  test("validates enum prop declarations, defaults, and consumer values", () => {
    const enumElement = pureElement();
    enumElement.props = {
      label: { kind: "enum", required: true, enum: ["info", "warning"], default: "info" },
    };
    const valid = {
      ...baseDefinition(),
      elements: { badge: enumElement },
      pages: { main: refPage(undefined, "badge", { label: "warning" }) },
    };
    expect(parseAppDefinition(valid).success).toBe(true);

    const missingValues = structuredClone(valid);
    delete missingValues.elements.badge.props.label.enum;
    expectParseIssue(missingValues, "enum values are required");

    const badDefault = structuredClone(valid);
    badDefault.elements.badge.props.label.default = "danger";
    expectParseIssue(badDefault, "default must be a valid enum value");

    const badConsumer = structuredClone(valid);
    badConsumer.pages.main.elements.ref.props.props.label = "danger";
    expectParseIssue(badConsumer, "must be a enum value or a binding");
  });

  test("rejects genuine cross-app reference cycles and chains deeper than five", async () => {
    const firstDefinition = {
      ...baseDefinition(),
      elements: { first: pureElement(true, false) },
    };
    const secondDefinition = {
      ...baseDefinition(),
      elements: { second: pureElement(true, false) },
    };
    const first = await createApp(firstDefinition, "Cross cycle first");
    const second = await createApp(secondDefinition, "Cross cycle second");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    replaceStoredDefinition(first.id!, {
      ...firstDefinition,
      elements: { first: exportedRefElement(second.id!, "second") },
    });
    replaceStoredDefinition(second.id!, {
      ...secondDefinition,
      elements: { second: exportedRefElement(first.id!, "first") },
    });
    const cyclicConsumer = await createApp(
      { ...baseDefinition(), pages: { main: refPage(first.id, "first") } },
      "Cross cycle consumer",
    );
    expect(cyclicConsumer.status).toBe(400);
    expect(
      cyclicConsumer.issues?.some((entry) =>
        entry.message.includes("recursive element reference cycle"),
      ),
    ).toBe(true);

    getDb().run("DELETE FROM apps");
    const definitions: ReturnType<typeof baseDefinition>[] = [];
    const appIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const name = `level${index + 1}`;
      const definition = {
        ...baseDefinition(),
        elements: { [name]: pureElement(true, false) },
      };
      definitions.push(definition);
      const created = await createApp(definition, `Cross depth ${index + 1}`);
      expect(created.status).toBe(201);
      appIds.push(created.id!);
    }
    for (let index = 0; index < 5; index += 1) {
      const name = `level${index + 1}`;
      replaceStoredDefinition(appIds[index]!, {
        ...definitions[index],
        elements: {
          [name]: exportedRefElement(appIds[index + 1]!, `level${index + 2}`),
        },
      });
    }
    const deepConsumer = await createApp(
      { ...baseDefinition(), pages: { main: refPage(appIds[0], "level1") } },
      "Cross depth consumer",
    );
    expect(deepConsumer.status).toBe(400);
    expect(deepConsumer.issues?.some((entry) => entry.message.includes("maximum depth of 5"))).toBe(
      true,
    );
  });

  test("treats reusable element definitions and their node entries atomically", () => {
    const storedDefinition = {
      ...baseDefinition(),
      elements: { card: pureElement() },
    };
    storedDefinition.elements.card.elements.label.props = {
      content: { $state: "/props/label" },
      tone: "muted",
    };
    const storedResult = parseAppDefinition(storedDefinition);
    expect(storedResult.success).toBe(true);
    if (!storedResult.success) return;

    const replacement = {
      mode: "pure",
      root: "text",
      elements: { text: { type: "Text", props: { content: "replacement" } } },
    };
    const patched = applyAppDefinitionPatch(storedResult.definition, {
      elements: { card: replacement },
    });
    expect(patched.success).toBe(true);
    if (!patched.success) return;
    expect((patched.definition as { elements: { card: unknown } }).elements.card).toEqual(
      replacement,
    );

    const nodePatched = applyAppDefinitionPatch(storedResult.definition, {
      elements: {
        card: {
          elements: {
            label: { type: "Text", props: { content: "node replacement" } },
          },
        },
      },
    });
    expect(nodePatched.success).toBe(true);
    if (!nodePatched.success) return;
    const card = (
      nodePatched.definition as {
        elements: { card: { mode: string; root: string; elements: Record<string, unknown> } };
      }
    ).elements.card;
    expect(card.mode).toBe("pure");
    expect(card.root).toBe("root");
    expect(card.elements.label).toEqual({
      type: "Text",
      props: { content: "node replacement" },
    });
    expect(card.elements.slot).toEqual({ type: "ElementSlot", props: {} });

    const deletedNode = applyAppDefinitionPatch(storedResult.definition, {
      elements: { card: { elements: { slot: null } } },
    });
    expect(deletedNode.success).toBe(true);
    if (deletedNode.success) {
      expect(
        Object.hasOwn(
          (deletedNode.definition as { elements: { card: { elements: object } } }).elements.card
            .elements,
          "slot",
        ),
      ).toBe(false);
    }

    const ambiguousNull = applyAppDefinitionPatch(storedResult.definition, {
      elements: {
        card: {
          mode: "pure",
          root: "root",
          elements: { slot: null },
        },
      },
    });
    expect(ambiguousNull.success).toBe(false);
    if (!ambiguousNull.success) {
      expect(ambiguousNull.issues[0]?.message).toBe(
        "null node in a full element replace — to delete a node use elements.<name>.elements.<id> = null",
      );
    }
  });

  test("snapshots elements and rollback restores their versioned definition", async () => {
    const initial = await createApp(baseDefinition(), "Versioned elements");
    expect(initial.status).toBe(201);
    const withElements = { ...baseDefinition(), elements: { card: pureElement(true) } };
    const add = await request(`/api/apps/${initial.id}`, {
      method: "PUT",
      body: JSON.stringify({ definition: withElements }),
    });
    expect(add.status).toBe(200);

    const replace = await request(`/api/apps/${initial.id}`, {
      method: "PUT",
      body: JSON.stringify({ definition: baseDefinition() }),
    });
    expect(replace.status).toBe(200);

    const versions = await request<{
      versions: Array<{ version: number; snapshot: { definition: { elements?: unknown } } }>;
    }>(`/api/apps/${initial.id}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions[0]?.snapshot.definition.elements).toEqual(withElements.elements);

    const rollback = await request<{ app: { definition: { elements?: unknown } } }>(
      `/api/apps/${initial.id}/rollback`,
      { method: "POST", body: JSON.stringify({ version: versions.body.versions[0]!.version }) },
    );
    expect(rollback.status).toBe(200);
    expect(rollback.body.app.definition.elements).toEqual(withElements.elements);
  });

  test("blocks breaking exported-element changes, reports invalid consumers, and honors force", async () => {
    const libraryDefinition = {
      ...baseDefinition(),
      elements: { card: pureElement(true) },
    };
    const library = await createApp(libraryDefinition, "Element Library");
    expect(library.status).toBe(201);

    const validConsumer = await createApp(
      {
        ...baseDefinition(),
        pages: { main: refPage(library.id, "card", { label: "valid" }) },
      },
      "Element Consumer",
    );
    expect(validConsumer.status).toBe(201);

    const rawConsumer = await createApp(
      {
        ...baseDefinition(),
        pages: { main: refPage(library.id, "card", { label: "raw" }) },
      },
      "Broken Raw Consumer",
    );
    expect(rawConsumer.status).toBe(201);
    const rawDefinition = {
      ...baseDefinition(),
      pages: {
        main: {
          ...refPage(library.id, "card", { label: "raw" }),
          elements: {
            ...refPage(library.id, "card", { label: "raw" }).elements,
            invalid: { type: "NotInTheCatalog", props: {} },
          },
        },
      },
    };
    getDb()
      .prepare("UPDATE apps SET definition = ? WHERE id = ?")
      .run(JSON.stringify(rawDefinition), rawConsumer.id!);

    const unscannable = await createApp(baseDefinition(), "Unscannable Consumer");
    expect(unscannable.status).toBe(201);
    getDb()
      .prepare("UPDATE apps SET definition = ? WHERE id = ?")
      .run(`not-json "element" "card" ${library.id}`, unscannable.id!);

    const unrelatedGarbage = await createApp(baseDefinition(), "Unrelated garbage");
    expect(unrelatedGarbage.status).toBe(201);
    getDb()
      .prepare("UPDATE apps SET definition = ? WHERE id = ?")
      .run("not-json without a possible element reference", unrelatedGarbage.id!);

    const blocked = await request<{ issues: Array<{ path: string; message: string }> }>(
      `/api/apps/${library.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ definition: { elements: { card: null } } }),
      },
    );
    expect(blocked.status).toBe(400);
    expect(blocked.body.issues[0]?.message).toContain("Element Consumer");
    expect(blocked.body.issues[0]?.message).toContain("raw scan: invalid definition");
    expect(blocked.body.issues[0]?.message).toContain("unscannable");
    expect(blocked.body.issues[0]?.message).not.toContain("Unrelated garbage");
    expect(blocked.body.issues[0]?.message).toContain('forceElementBreak: ["card"]');

    const forced = await request(`/api/apps/${library.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        definition: { elements: { card: null } },
        forceElementBreak: ["card"],
      }),
    });
    expect(forced.status).toBe(200);
  });

  test("keeps the exported-element gate active while repairing a broken producer", async () => {
    const libraryDefinition = {
      ...baseDefinition(),
      elements: { card: pureElement(true) },
    };
    const library = await createApp(libraryDefinition, "Broken producer library");
    expect(library.status).toBe(201);
    const consumer = await createApp(
      {
        ...baseDefinition(),
        pages: { main: refPage(library.id, "card", { label: "still referenced" }) },
      },
      "Broken producer consumer",
    );
    expect(consumer.status).toBe(201);

    replaceStoredDefinition(library.id!, {
      elements: libraryDefinition.elements,
      pages: libraryDefinition.pages,
      defaultPage: libraryDefinition.defaultPage,
    });
    expect(getApp(library.id!)?.definitionError).toBeDefined();

    const repairWithoutExport = await request<{ issues: Array<{ message: string }> }>(
      `/api/apps/${library.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ definition: baseDefinition() }),
      },
    );
    expect(repairWithoutExport.status).toBe(400);
    expect(repairWithoutExport.body.issues[0]?.message).toContain("Broken producer consumer");
    expect(repairWithoutExport.body.issues[0]?.message).toContain("removed");
  });

  test("does not let unrelated malformed JSON block an unreferenced export change", async () => {
    const library = await createApp(
      { ...baseDefinition(), elements: { card: pureElement(true) } },
      "Unreferenced export library",
    );
    expect(library.status).toBe(201);
    const garbage = await createApp(baseDefinition(), "Unrelated malformed app");
    expect(garbage.status).toBe(201);
    getDb()
      .prepare("UPDATE apps SET definition = ? WHERE id = ?")
      .run("not-json without target markers", garbage.id!);

    const removed = await request(`/api/apps/${library.id}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: { elements: { card: null } } }),
    });
    expect(removed.status).toBe(200);
  });

  test("does not substring-match cardList as a reference to card", async () => {
    const libraryDefinition = {
      ...baseDefinition(),
      elements: {
        card: pureElement(true),
        cardList: pureElement(true),
      },
    };
    const library = await createApp(libraryDefinition, "Substring library");
    expect(library.status).toBe(201);
    const consumer = await createApp(
      {
        ...baseDefinition(),
        pages: { main: refPage(library.id, "cardList", { label: "list only" }) },
      },
      "Substring consumer",
    );
    expect(consumer.status).toBe(201);
    const invalidConsumer = {
      ...baseDefinition(),
      pages: {
        main: {
          ...refPage(library.id, "cardList", { label: "list only" }),
          elements: {
            ...refPage(library.id, "cardList", { label: "list only" }).elements,
            invalid: { type: "NotInTheCatalog", props: {} },
          },
        },
      },
    };
    replaceStoredDefinition(consumer.id!, invalidConsumer);

    const removed = await request(`/api/apps/${library.id}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: { elements: { card: null } } }),
    });
    expect(removed.status).toBe(200);
  });

  test("does not treat ElementRef-shaped action args as consumers", async () => {
    const library = await createApp(
      { ...baseDefinition(), elements: { card: pureElement(true) } },
      "Action-arg library",
    );
    expect(library.status).toBe(201);
    const consumer = await createApp(baseDefinition(), "Action-arg non-consumer");
    expect(consumer.status).toBe(201);
    replaceStoredDefinition(consumer.id!, {
      ...baseDefinition(),
      actions: {
        fake: {
          kind: "script",
          scriptId: crypto.randomUUID(),
          args: {
            payload: {
              type: "ElementRef",
              props: { app: library.id, element: "card" },
            },
          },
        },
      },
    });

    const removed = await request(`/api/apps/${library.id}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: { elements: { card: null } } }),
    });
    expect(removed.status).toBe(200);
  });

  test("rejects unknown forceElementBreak names and force on create", async () => {
    const definition = {
      ...baseDefinition(),
      elements: { card: pureElement(true) },
    };
    const app = await createApp(definition, "Force typo guard");
    expect(app.status).toBe(201);

    const typo = await request<{ issues: Array<{ message: string }> }>(`/api/apps/${app.id}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: {}, forceElementBreak: ["crad"] }),
    });
    expect(typo.status).toBe(400);
    expect(typo.body.issues[0]?.message).toBe('forceElementBreak names unknown element "crad"');

    const preauthorized = await request(`/api/apps/${app.id}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: {}, forceElementBreak: ["card"] }),
    });
    expect(preauthorized.status).toBe(200);

    const createWithForce = await request<{ error: string }>("/api/apps", {
      method: "POST",
      body: JSON.stringify({
        name: "Invalid force create",
        definition,
        forceElementBreak: ["card"],
      }),
    });
    expect(createWithForce.status).toBe(400);
    expect(createWithForce.body.error).toContain("forceElementBreak requires an existing app");
  });

  test("applies the exported-element compatibility gate to rollback", async () => {
    const library = await createApp(baseDefinition(), "Rollback Library");
    expect(library.status).toBe(201);
    const withElement = {
      ...baseDefinition(),
      elements: { card: pureElement(true) },
    };
    const added = await request(`/api/apps/${library.id}`, {
      method: "PUT",
      body: JSON.stringify({ definition: withElement }),
    });
    expect(added.status).toBe(200);

    const consumer = await createApp(
      {
        ...baseDefinition(),
        pages: { main: refPage(library.id, "card", { label: "rollback" }) },
      },
      "Rollback Consumer",
    );
    expect(consumer.status).toBe(201);

    const blocked = await request<{ issues: Array<{ message: string }> }>(
      `/api/apps/${library.id}/rollback`,
      { method: "POST", body: JSON.stringify({ version: 1 }) },
    );
    expect(blocked.status).toBe(400);
    expect(blocked.body.issues[0]?.message).toContain("Rollback Consumer");

    const forced = await request(`/api/apps/${library.id}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version: 1, forceElementBreak: ["card"] }),
    });
    expect(forced.status).toBe(200);
  });

  test("allows private unreferenced element churn and zero-model pure-UI apps", async () => {
    const privateDefinition = {
      ...baseDefinition(),
      elements: { privateCard: pureElement() },
    };
    const app = await createApp(privateDefinition, "Private churn");
    expect(app.status).toBe(201);
    const removed = await request(`/api/apps/${app.id}`, {
      method: "PATCH",
      body: JSON.stringify({ definition: { elements: { privateCard: null } } }),
    });
    expect(removed.status).toBe(200);

    const pureUi = {
      models: {},
      elements: { card: pureElement() },
      pages: { main: refPage(undefined, "card", { label: "No models" }) },
      defaultPage: "main",
    };
    const pureUiApp = await createApp(pureUi, "Pure UI");
    expect(pureUiApp.status).toBe(201);
    const fetched = await request<{ app: { definition: { models: unknown } } }>(
      `/api/apps/${pureUiApp.id}`,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body.app.definition.models).toEqual({});
  });
});
