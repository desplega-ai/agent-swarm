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
    const created: string[] = [];
    try {
      for (const [label, definition] of [
        ["otp", otp],
        ["gantt", gantt],
      ] as const) {
        const response = await ctx.api("POST", "/api/apps", {
          body: { name: `E2E primitives ${label} ${ctx.nonce}`, definition },
        });
        expectStatus(response, [201], `the ${label} example validates`);
        created.push(String(asRecord(asRecord(response.json).app).id));
      }

      const otpCell = (def: Json) => def.pages.verify.elements.cell.props;
      const ganttEl = (def: Json) => def.pages.plan.elements;
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
    } finally {
      for (const id of created) await ctx.api("DELETE", `/api/apps/${id}`);
    }
  },
};
