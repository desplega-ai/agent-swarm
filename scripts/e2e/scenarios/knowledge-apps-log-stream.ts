import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// biome-ignore lint/suspicious/noExplicitAny: the cases mutate the definition in place.
type Json = Record<string, any>;

function definition(): Json {
  return {
    models: {},
    defaultPage: "logs",
    actions: {
      tail: { kind: "task", prompt: "Replace with a script action that returns { logs: [...] }" },
    },
    pages: {
      logs: {
        title: "Logs",
        root: "stream",
        elements: {
          stream: {
            type: "LogStream",
            props: {
              data: { $state: "/actions/tail/result/logs" },
              loading: { $state: "/actions/tail/running" },
              timeField: "timestamp",
              bodyField: "body",
              severityField: "severity_text",
              serviceField: "service.name",
              attributesField: "attributes",
              traceField: "traceId",
              keyField: "cursor",
              follow: true,
              onTrace: [
                {
                  action: "app.navigate",
                  params: { page: "trace", params: { traceId: { $row: "traceId" } } },
                },
              ],
            },
          },
        },
      },
      trace: {
        title: "Trace",
        params: { traceId: { kind: "string" } },
        root: "t",
        elements: { t: { type: "Text", props: { content: "trace" } } },
      },
    },
  };
}

/** `LogStream`: a log tail fed by an action result validates; its fields and `onTrace` chain are checked. */
export const knowledgeAppsLogStream: Scenario = {
  name: "knowledge-apps-log-stream",
  order: 557,
  async run(ctx) {
    const created: string[] = [];
    try {
      let response = await ctx.api("POST", "/api/apps", {
        body: { name: `E2E log stream ${ctx.nonce}`, definition: definition() },
      });
      expectStatus(response, [201], "a LogStream definition validates");
      created.push(String(asRecord(asRecord(response.json).app).id));

      const stream = (d: Json) => d.pages.logs.elements.stream.props;
      const cases: [string, (d: Json) => void, string, RegExp][] = [
        [
          "bodyField is required",
          (d) => delete stream(d).bodyField,
          "pages.logs.elements.stream.props.bodyField",
          /required/,
        ],
        [
          "onTrace steps are validated",
          (d) => (stream(d).onTrace[0] = { action: "app.action", params: { name: "nope" } }),
          "pages.logs.elements.stream.props.onTrace.0.params.name",
          /./,
        ],
        [
          "unknown props are rejected",
          (d) => (stream(d).columns = []),
          "pages.logs.elements.stream.props.columns",
          /unknown property/,
        ],
      ];
      for (const [label, mutate, path, message] of cases) {
        const bad = definition();
        mutate(bad);
        response = await ctx.api("POST", "/api/apps", {
          body: { name: `E2E log stream bad ${ctx.nonce}`, definition: bad },
        });
        expectStatus(response, [400], label);
        const issues = asRecords(response.json, "issues");
        expect(
          issues.some((found) => found.path === path && message.test(String(found.message))),
          `${label}: expected ${path} ${message}, got ${JSON.stringify(issues).slice(0, 400)}`,
        );
      }
    } finally {
      for (const id of created) await ctx.api("DELETE", `/api/apps/${id}`);
    }
  },
};
