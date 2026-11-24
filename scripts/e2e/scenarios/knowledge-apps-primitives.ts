import { join } from "node:path";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// biome-ignore lint/suspicious/noExplicitAny: the cases mutate parsed example JSON in place.
type Json = Record<string, any>;

/** A JSON example of the apps skill (`### Example: <heading>` then a json fence). */
async function skillExample(heading: string): Promise<Json> {
  const doc = await Bun.file(
    join(import.meta.dir, "../../../templates/skills/apps/content.md"),
  ).text();
  const start = doc.indexOf(`### Example: ${heading}`);
  const block = /```json\n([\s\S]*?)\n```/.exec(doc.slice(start));
  expect(start >= 0 && block, `apps skill example "${heading}" not found`);
  return JSON.parse(block![1]!);
}

/**
 * The low-level primitives (page `state`, Input, ui.* steps, expressions, Svg):
 * the apps skill's two examples validate, and every guard rejects with a path.
 */
export const knowledgeAppsPrimitives: Scenario = {
  name: "knowledge-apps-primitives",
  order: 552,
  async run(ctx) {
    const otp = await skillExample("6-cell code input");
    const gantt = await skillExample("Gantt timeline");
    const enter = await skillExample("Load on enter");
    const shared = await skillExample("Shared window and action-fed chart");
    const created: string[] = [];
    try {
      for (const [label, definition] of [
        ["otp", otp],
        ["gantt", gantt],
        ["enter", enter],
        ["shared", shared],
      ] as const) {
        const response = await ctx.api("POST", "/api/apps", {
          body: { name: `E2E primitives ${label} ${ctx.nonce}`, definition },
        });
        expectStatus(response, [201], `the ${label} example validates`);
        created.push(String(asRecord(asRecord(response.json).app).id));
      }

      const otpCell = (def: Json) => def.pages.verify.elements.cell.props;
      const ganttEl = (def: Json) => def.pages.plan.elements;
      const enterEl = (def: Json) => def.pages.trace.elements;
      const sharedEl = (def: Json) => def.pages.overview.elements;
      const cases: [string, Json, (def: Json) => void, string, RegExp][] = [
        [
          "Svg attrs are allowlisted",
          gantt,
          (d) => (ganttEl(d).bar.props.onclick = "x"),
          "pages.plan.elements.bar.props.onclick",
          /unknown property/,
        ],
        [
          "Svg paint is a token",
          gantt,
          (d) => (ganttEl(d).bar.props.fill = "url(https://x/y#a)"),
          "pages.plan.elements.bar.props.fill",
          /must be one of/,
        ],
        [
          "Path data is commands and numbers",
          gantt,
          (d) => {
            ganttEl(d).chart.children.push("p");
            ganttEl(d).p = { type: "Path", props: { d: 'M0 0"/><script>' } };
          },
          "pages.plan.elements.p.props.d",
          /path commands/,
        ],
        [
          "shapes live inside an Svg",
          gantt,
          (d) => {
            ganttEl(d).card.children.push("loose");
            ganttEl(d).loose = { type: "Rect", props: { x: 0, y: 0, width: 1, height: 1 } };
          },
          "pages.plan.elements.loose.type",
          /child of an Svg/,
        ],
        [
          "Svg children are shapes",
          gantt,
          (d) => {
            ganttEl(d).chart.children.push("html");
            ganttEl(d).html = { type: "Text", props: { content: "x" } };
          },
          "pages.plan.elements.chart.children.3",
          /Svg children/,
        ],
        [
          "$bindState writes only /local",
          otp,
          (d) => (otpCell(d).value = { $bindState: "/queries/q/data" }),
          "pages.verify.elements.cell.props.value",
          /only page-local/,
        ],
        [
          "$bindState only on Input.value",
          otp,
          (d) => (d.pages.verify.elements.heading.props.text = { $bindState: "/local/code" }),
          "pages.verify.elements.heading.props.text",
          /only allowed on Input.value/,
        ],
        [
          "/local names are declared",
          otp,
          (d) => (d.pages.verify.elements.submitted.props.content = { $state: "/local/nope" }),
          "pages.verify.elements.submitted.props.content",
          /undeclared page state "nope"/,
        ],
        [
          "ui.set writes only /local",
          otp,
          (d) => (otpCell(d).onPaste[1].params.path = "/queries/q"),
          "pages.verify.elements.cell.props.onPaste.1.params.path",
          /only page-local/,
        ],
        [
          "ui.focus targets an Input id",
          otp,
          (d) => (otpCell(d).onInput[1].params.id = "nope"),
          "pages.verify.elements.cell.props.onInput.1.params.id",
          /no Input with id "nope"/,
        ],
        [
          "expression operand counts",
          otp,
          (d) => (otpCell(d).onInput[1].params.index = { $sub: [1] }),
          "pages.verify.elements.cell.props.onInput.1.params.index.$sub",
          /2 operand/,
        ],
        [
          "comparison operand counts",
          enter,
          (d) => (enterEl(d).busy.props.content.$if[0] = { $eq: ["a"] }),
          "pages.trace.elements.busy.props.content.$if.0.$eq",
          /2 operand/,
        ],
        [
          "OnEnter chains name declared actions",
          enter,
          (d) => (enterEl(d).enter.on.enter[1].params.name = "nope"),
          "pages.trace.elements.enter.on.enter.1.params.name",
          /./,
        ],
        [
          "app state must be declared",
          shared,
          (d) => (sharedEl(d).load.props.deps = { $state: "/app/nope" }),
          "pages.overview.elements.load.props.deps",
          /undeclared app state "nope"/,
        ],
        [
          "key events are allowlisted",
          otp,
          (d) => (otpCell(d)["onKeyDown:F5"] = []),
          "pages.verify.elements.cell.props.onKeyDown:F5",
          /unknown property/,
        ],
        [
          "pure elements keep their no-action rule",
          otp,
          (d) => {
            d.elements = {
              field: {
                mode: "pure",
                root: "i",
                elements: {
                  i: {
                    type: "Input",
                    props: { id: "i", onInput: [{ action: "ui.focus", params: { id: "i" } }] },
                  },
                },
              },
            };
          },
          "elements.field.elements.i.props.onInput.0.action",
          /pure elements cannot invoke actions/,
        ],
      ];
      for (const [label, example, mutate, path, message] of cases) {
        const definition = structuredClone(example);
        mutate(definition);
        const response = await ctx.api("POST", "/api/apps", {
          body: { name: `E2E primitives bad ${ctx.nonce}`, definition },
        });
        expectStatus(response, [400], label);
        const issues = asRecords(response.json, "issues");
        expect(
          issues.some((found) => found.path === path && message.test(String(found.message))),
          `${label}: expected ${path} ${message}, got ${JSON.stringify(issues).slice(0, 400)}`,
        );
      }

      // A borrowed element must receive app-wide state explicitly through props.
      // Its action runs in the defining app, but /app belongs to the consumer.
      const provider = structuredClone(shared);
      provider.elements = {
        report: {
          mode: "bound",
          export: true,
          props: { window: { kind: "string", required: true } },
          root: "load",
          elements: {
            load: {
              type: "OnEnter",
              props: { deps: { $state: "/props/window" } },
              on: {
                enter: [
                  {
                    action: "app.action",
                    params: { name: "red", input: { window: { $state: "/props/window" } } },
                  },
                ],
              },
            },
          },
        },
      };
      const supplied = await ctx.api("POST", "/api/apps", {
        body: { name: `E2E state provider ${ctx.nonce}`, definition: provider },
      });
      expectStatus(supplied, [201], "bound element accepts explicit app-state props");
      const providerId = String(asRecord(asRecord(supplied.json).app).id);
      created.push(providerId);
      const borrowed = await ctx.api("POST", "/api/apps", {
        body: {
          name: `E2E state consumer ${ctx.nonce}`,
          definition: {
            models: {},
            state: { window: "consumer-private" },
            defaultPage: "main",
            pages: {
              main: {
                root: "borrowed",
                elements: {
                  borrowed: {
                    type: "ElementRef",
                    props: {
                      app: providerId,
                      element: "report",
                      props: { window: { $state: "/app/window" } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      expectStatus(borrowed, [201], "consumer explicitly passes its own app-wide state");
      created.push(String(asRecord(asRecord(borrowed.json).app).id));
      // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
      const appTemplate = "w=${/app/window}";
      for (const exported of [true, false]) {
        for (const [binding, read] of [
          ["deps", { $state: "/app/window" }],
          ["input", { $state: "/app/window" }],
          ["deps", { $template: appTemplate }],
          ["input", { $template: appTemplate }],
        ] as const) {
          const definition = structuredClone(provider);
          const report = definition.elements.report;
          report.export = exported;
          const load = report.elements.load;
          if (binding === "deps") load.props.deps = read;
          else load.on.enter[0].params.input.window = read;
          const rejected = await ctx.api("PUT", `/api/apps/${providerId}`, {
            body: { definition },
          });
          expectStatus(
            rejected,
            [400],
            `${exported ? "exported" : "private"} ${binding} read ${JSON.stringify(read)}`,
          );
          const field = binding === "deps" ? "props.deps" : "on.enter.0.params.input.window";
          const suffix = "$template" in read ? `${field}.$template` : field;
          expect(
            asRecords(rejected.json, "issues").some(
              (found) =>
                found.path === `elements.report.elements.load.${suffix}` &&
                String(found.message).includes("elements cannot read /app state"),
            ),
            `borrowed elements cannot implicitly read consumer state through ${binding} ${JSON.stringify(read)}`,
          );
        }
      }
    } finally {
      for (const id of created) await ctx.api("DELETE", `/api/apps/${id}`);
    }
  },
};
