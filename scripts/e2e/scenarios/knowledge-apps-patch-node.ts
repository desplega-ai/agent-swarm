import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";
import { callToolErr, callToolOk, structured, toolText, withMcp } from "./script-helpers";

const CARDS = 38;
const FILLER = "Fleet utilisation across regions, refreshed nightly from the ops feed. ".repeat(8);

/** A ~60 KB, 191-node page: a root Stack of Cards, each with two Texts and two Metrics. */
function fixtureDefinition(): Record<string, unknown> {
  const elements: Record<string, unknown> = {};
  const cards: string[] = [];
  for (let i = 0; i < CARDS; i++) {
    const card = `c${i}`;
    cards.push(card);
    elements[card] = {
      type: "Card",
      props: { title: `Region ${i}`, description: FILLER.slice(0, 120) },
      children: [`t${i}a`, `t${i}b`, `m${i}`, `n${i}`],
    };
    elements[`t${i}a`] = { type: "Text", props: { content: `${i}: ${FILLER}` } };
    elements[`t${i}b`] = { type: "Text", props: { content: `${FILLER}(${i})`, tone: "muted" } };
    elements[`m${i}`] = { type: "Metric", props: { label: `Active ${i}`, value: i, loading: true } };
    elements[`n${i}`] = { type: "Metric", props: { label: `Idle ${i}`, value: i * 2 } };
  }
  elements.root = { type: "Stack", props: { gap: "md" }, children: cards };
  return {
    models: { fleet: { columns: { day: { kind: "string" }, active: { kind: "number" } } } },
    queries: { byDay: { model: "fleet", filter: { day: { $param: "day" } } } },
    actions: {},
    pages: { overview: { title: "Overview", root: "root", elements } },
    defaultPage: "overview",
  };
}

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * What one tool call costs an agent: a harness reads one channel (text or structured), so the
 * larger of the two. A spilled result (over the 10 KB wire limit) fails here instead.
 */
function channelBytes(result: Record<string, unknown>): number {
  expect(structured(result).truncation === undefined, "the result did not spill to KV");
  return Math.max(new TextEncoder().encode(toolText(result)).length, bytes(structured(result)));
}

/**
 * `app-patch-node` edits one node, `app-get {outline | path}` reads the smallest subtree, and
 * the write answers with a compact summary. One prop edit on a 60 KB app moves at most 12 KB.
 */
export const knowledgeAppsPatchNode: Scenario = {
  name: "knowledge-apps-patch-node",
  order: 558.5,
  async run(ctx) {
    const owner = await registerAgent(ctx, "app-patch-node-owner");
    const definition = fixtureDefinition();
    const definitionBytes = bytes(definition);
    expect(definitionBytes > 50_000, `fixture is ~60 KB (${definitionBytes} bytes)`);
    const created = await ctx.api("POST", "/api/apps", {
      agentId: owner,
      body: { name: `E2E patch node ${ctx.nonce}`, definition },
    });
    expectStatus(created, [201], "create the fixture app");
    const appId = asString(asRecord(asRecord(created.json).app).id, "app id");
    const page = "pages.overview.elements";
    const storedAt = async (): Promise<string> => {
      const response = await ctx.api("GET", `/api/apps/${appId}`, { agentId: owner });
      expectStatus(response, [200], "read the app");
      return asString(asRecord(asRecord(response.json).app).updatedAt, "updatedAt");
    };
    try {
      await withMcp(ctx, owner, async (mcp) => {
        // ── outline: the tree without props, under 10 KB ──
        let result = await callToolOk(mcp, "app-get", { appId, outline: true });
        const outlineBytes = channelBytes(result);
        ctx.log(`outline_bytes=${outlineBytes} definition_bytes=${definitionBytes}`);
        expect(outlineBytes <= 10_000, `outline is at most 10 KB (${outlineBytes})`);
        const outline = asRecord(structured(result).outline);
        const nodes = asRecord(asRecord(asRecord(outline.pages).overview).nodes);
        expect(
          JSON.stringify(nodes.m0) === '["Metric"]' && Object.keys(nodes).length === CARDS * 5 + 1,
          `outline lists every node with its type: ${JSON.stringify(nodes.m0)}`,
        );
        expect(
          JSON.stringify(nodes.c0) === '["Card",["t0a","t0b","m0","n0"]]',
          `outline lists child ids: ${JSON.stringify(nodes.c0)}`,
        );
        expect(
          JSON.stringify(asRecord(outline.models).fleet) === '["day","active"]' &&
            JSON.stringify(asRecord(asRecord(outline.queries).byDay).params) === '["day"]',
          `outline lists columns and query params: ${JSON.stringify(outline.queries)}`,
        );
        expect(!JSON.stringify(outline).includes("Fleet utilisation"), "outline omits props");

        // ── path: only the subtree, by dot path or JSON pointer ──
        result = await callToolOk(mcp, "app-get", { appId, path: `${page}.m0` });
        const readBytes = channelBytes(result);
        const node = asRecord(structured(result).value);
        expect(
          node.type === "Metric" && asRecord(node.props).loading === true && readBytes < 2_000,
          `path returns only the node (${readBytes} bytes): ${JSON.stringify(node)}`,
        );
        result = await callToolOk(mcp, "app-get", {
          appId,
          path: "/pages/overview/elements/m0/props/label",
        });
        expect(structured(result).value === "Active 0", "a JSON pointer reads the same subtree");
        result = await callToolErr(mcp, "app-get", { appId, path: `${page}.m00` });
        expect(
          (structured(result).closest as string[] | undefined)?.includes("m0") === true,
          `a missed path names the closest keys: ${JSON.stringify(structured(result).closest)}`,
        );

        // ── one prop edit: a compact response and a one-line diff ──
        result = await callToolOk(mcp, "app-patch-node", {
          appId,
          page: "overview",
          nodeId: "m0",
          props: { loading: false },
        });
        const writeBytes = channelBytes(result);
        let out = structured(result);
        ctx.log(`read_bytes=${readBytes} write_bytes=${writeBytes}`);
        expect(writeBytes <= 4_000, `the write response is at most 4 KB (${writeBytes})`);
        expect(out.app === undefined, "the write does not echo the app");
        expect(
          JSON.stringify(out.changed) === `["${page}.m0.props.loading"]`,
          `changed names the one prop: ${JSON.stringify(out.changed)}`,
        );
        expect(
          readBytes + writeBytes <= 12_000,
          `read plus write move at most 12 KB (${readBytes + writeBytes})`,
        );
        const version = out.versionCreated;
        expect(typeof version === "number", "the write names its snapshot version");
        result = await callToolOk(mcp, "app-diff", { appId, from: version });
        const diffLines = String(structured(result).diff)
          .split("\n")
          .filter((line) => /^[+-](?![+-]{2})/.test(line));
        expect(
          diffLines.length === 2 && diffLines.every((line) => line.includes('"loading"')),
          `app-diff shows a one-line change: ${JSON.stringify(diffLines)}`,
        );

        // ── dryRun and a bad prop store nothing ──
        const before = await storedAt();
        result = await callToolOk(mcp, "app-patch-node", {
          appId,
          page: "overview",
          nodeId: "m0",
          props: { loading: true },
          dryRun: true,
        });
        out = structured(result);
        expect(
          out.dryRun === true && JSON.stringify(out.changed) === `["${page}.m0.props.loading"]`,
          `dryRun reports the change: ${JSON.stringify(out)}`,
        );
        result = await callToolErr(mcp, "app-patch-node", {
          appId,
          page: "overview",
          nodeId: "m0",
          props: { loading: "soon" },
        });
        const issues = structured(result).issues as Array<{ path?: string }> | undefined;
        expect(
          issues?.[0]?.path === `${page}.m0.props.loading`,
          `a bad prop is reported at its path: ${JSON.stringify(issues)}`,
        );
        result = await callToolErr(mcp, "app-patch-node", {
          appId,
          page: "overview",
          nodeId: "m00",
          props: { loading: false },
        });
        const closest = structured(result).closest as string[] | undefined;
        expect(
          closest?.includes("m0") === true && closest.length <= 5,
          `a missing node names the closest ids: ${JSON.stringify(closest)}`,
        );
        expect((await storedAt()) === before, "dryRun and refused edits store nothing");

        // ── create links the node at its index; remove unlinks it and drops its subtree ──
        await callToolOk(mcp, "app-patch-node", {
          appId,
          page: "overview",
          nodeId: "fresh",
          create: { parentId: "c0", index: 1, node: { type: "Text", props: { content: "new" } } },
        });
        result = await callToolOk(mcp, "app-get", { appId, path: `${page}.c0.children` });
        expect(
          JSON.stringify(structured(result).value) === '["t0a","fresh","t0b","m0","n0"]',
          `create links the node at index 1: ${JSON.stringify(structured(result).value)}`,
        );
        result = await callToolOk(mcp, "app-patch-node", {
          appId,
          page: "overview",
          nodeId: "c1",
          remove: true,
        });
        expect(
          (structured(result).changedCount ?? (structured(result).changed as unknown[]).length) ===
            6,
          `remove drops the card, its 4 children and the parent link: ${JSON.stringify(structured(result).changed)}`,
        );
        result = await callToolOk(mcp, "app-get", { appId, outline: true });
        const after = asRecord(asRecord(asRecord(structured(result).outline).pages).overview);
        const afterNodes = asRecord(after.nodes);
        expect(
          afterNodes.c1 === undefined &&
            afterNodes.t1a === undefined &&
            !JSON.stringify(afterNodes.root).includes('"c1"'),
          "remove unlinks the node from its parent",
        );

        // ── ops: a failing test stores nothing; a passing one applies ──
        const atOps = await storedAt();
        const loadingPath = "/pages/overview/elements/m0/props/loading";
        result = await callToolErr(mcp, "app-patch", {
          appId,
          ops: [
            { op: "test", path: loadingPath, value: true },
            { op: "replace", path: loadingPath, value: true },
          ],
        });
        expect(
          (structured(result).issues as Array<{ path?: string }> | undefined)?.[0]?.path ===
            "ops[0]",
          `a failing test op is reported at ops[0]: ${JSON.stringify(structured(result).issues)}`,
        );
        expect((await storedAt()) === atOps, "a failing test op stores nothing");
        result = await callToolOk(mcp, "app-patch", {
          appId,
          ops: [
            { op: "test", path: loadingPath, value: false },
            { op: "replace", path: loadingPath, value: true },
            { op: "add", path: "/pages/overview/elements/root/children/-", value: "fresh2" },
            {
              op: "add",
              path: "/pages/overview/elements/fresh2",
              value: { type: "Text", props: { content: "tail" } },
            },
          ],
        });
        out = structured(result);
        expect(
          JSON.stringify(out.changed) ===
            `["${page}.m0.props.loading","${page}.root.children","${page}.fresh2"]`,
          `passing ops apply in order: ${JSON.stringify(out.changed)}`,
        );
        result = await callToolOk(mcp, "app-get", { appId, path: `${page}.fresh2.type` });
        expect(structured(result).value === "Text", "an added node is stored");

        // ── REST PATCH takes the same ops ──
        const rest = await ctx.api("PATCH", `/api/apps/${appId}`, {
          agentId: owner,
          body: { ops: [{ op: "test", path: loadingPath, value: false }] },
        });
        expectStatus(rest, [400], "REST PATCH refuses a failing test op");
      });
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`, { agentId: owner });
    }
  },
};
