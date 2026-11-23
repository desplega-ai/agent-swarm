import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

function threadApp(attachments: Record<string, unknown>) {
  return {
    models: {},
    queries: {},
    actions: { reply: { kind: "task", prompt: "Answer the message" } },
    pages: {
      main: {
        root: "thread",
        elements: {
          thread: {
            type: "SessionThread",
            props: {
              id: "thread",
              sessionKey: "main",
              attachments,
              onDispatch: [
                { action: "app.action", params: { name: "reply", input: { $form: "" } } },
              ],
            },
          },
        },
      },
    },
    defaultPage: "main",
  };
}

/**
 * A SessionThread's `attachments` option: a valid one saves as written, and
 * the server refuses a relative `dir` and a file limit of 0 or below.
 */
export const knowledgeAppsSessionThreadFiles: Scenario = {
  name: "knowledge-apps-session-thread-files",
  order: 555,
  async run(ctx) {
    const attachments = {
      dir: `/e2e/${ctx.nonce}/attachments`,
      accept: [".pdf", "image/*"],
      maxFiles: 3,
      maxBytes: 1048576,
    };
    const created = await ctx.api("POST", "/api/apps", {
      body: { name: `E2E thread files ${ctx.nonce}`, definition: threadApp(attachments) },
    });
    expectStatus(created, [201], "a SessionThread with attachments saves");
    const id = asString(asRecord(asRecord(created.json).app).id, "app id");
    try {
      const read = await ctx.api("GET", `/api/apps/${id}`);
      expectStatus(read, [200], "read the app");
      const definition = asRecord(asRecord(read.json).app).definition;
      const saved = asRecord(asRecord(asRecord(definition).pages).main).elements;
      expect(
        JSON.stringify(asRecord(asRecord(asRecord(saved).thread).props).attachments) ===
          JSON.stringify(attachments),
        "the attachments option is stored as written",
      );

      const path = "pages.main.elements.thread.props.attachments";
      const cases: [string, Record<string, unknown>, string, RegExp][] = [
        ["no files per message", { maxFiles: 0 }, `${path}.maxFiles`, /positive integer/],
        ["negative files per message", { maxFiles: -1 }, `${path}.maxFiles`, /positive integer/],
        ["a 0-byte file cap", { maxBytes: 0 }, `${path}.maxBytes`, /positive integer/],
        ["a relative folder", { dir: "attachments" }, `${path}.dir`, /absolute agent-fs path/],
      ];
      for (const [label, change, issuePath, message] of cases) {
        const response = await ctx.api("POST", "/api/apps", {
          body: {
            name: `E2E thread files bad ${ctx.nonce}`,
            definition: threadApp({ ...attachments, ...change }),
          },
        });
        expectStatus(response, [400], label);
        const issues = asRecords(response.json, "issues");
        expect(
          issues.some((found) => found.path === issuePath && message.test(String(found.message))),
          `${label}: expected ${issuePath} ${message}, got ${JSON.stringify(issues).slice(0, 400)}`,
        );
      }
    } finally {
      await ctx.api("DELETE", `/api/apps/${id}`);
    }
  },
};
