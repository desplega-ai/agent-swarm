import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// biome-ignore lint/suspicious/noExplicitAny: the cases mutate a plain JSON definition in place.
type Json = Record<string, any>;

/**
 * `${path}` reads inside a page's `{ "$template": "..." }` get the same path checks as a
 * `{ "$state": "..." }` read, so a template naming undeclared state is a 400. A bare
 * `${name}` inside a repeat stays legal: json-render reads it from the repeat item first.
 */
function definitionWith(
  deps: unknown,
  input: unknown,
  label: unknown = "Window",
  rowLabel: unknown = "Row",
): Json {
  return {
    models: {},
    state: { window: "1h" },
    queries: {},
    actions: { load: { kind: "task", prompt: "No execution needed" } },
    defaultPage: "main",
    pages: {
      main: {
        params: { range: { kind: "string" } },
        state: { draft: "", items: [{ name: "first" }] },
        root: "root",
        elements: {
          root: { type: "Stack", props: {}, children: ["load", "label", "list"] },
          load: {
            type: "OnEnter",
            props: { deps },
            on: {
              enter: [{ action: "app.action", params: { name: "load", input: { window: input } } }],
            },
          },
          label: { type: "OnEnter", props: { deps: label } },
          list: {
            type: "Stack",
            props: {},
            repeat: { statePath: "/local/items" },
            children: ["row"],
          },
          row: { type: "OnEnter", props: { deps: rowLabel } },
        },
      },
    },
  };
}

const t = (template: string) => ({ $template: template });

export const knowledgeAppsTemplateRefs: Scenario = {
  name: "knowledge-apps-template-refs",
  order: 556.5,
  async run(ctx) {
    const created: string[] = [];
    try {
      const accepted = await ctx.api("POST", "/api/apps", {
        body: {
          name: `template refs ${ctx.nonce}`,
          definition: definitionWith(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
            t("${/app/window}|${app/window}|${/route/params/range}|${/local/draft}"),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
            t("${/actions/load/status}"),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
            t("w=${local/draft}"),
            // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
            t("item ${name}"),
          ),
        },
      });
      expectStatus(accepted, [201], "declared template reads and repeat-item reads are accepted");
      const appId = String(asRecord(asRecord(accepted.json).app).id);
      expect(appId.length > 0, "app saved");
      created.push(appId);

      // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
      const undeclaredApp = ["${app/nope}", "${/app/nope}"];
      const rejections: Array<[string, Json, string, string]> = [];
      for (const read of undeclaredApp) {
        rejections.push([
          `deps ${read}`,
          definitionWith(t(read), "1h"),
          "pages.main.elements.load.props.deps.$template",
          'undeclared app state "nope"',
        ]);
        rejections.push([
          `input ${read}`,
          definitionWith("load", t(read)),
          "pages.main.elements.load.on.enter.0.params.input.window.$template",
          'undeclared app state "nope"',
        ]);
      }
      rejections.push(
        [
          "undeclared page state",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
          definitionWith("load", "1h", t("${/local/nope}")),
          "pages.main.elements.label.props.deps.$template",
          'undeclared page state "nope"',
        ],
        [
          "unknown route param",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
          definitionWith("load", "1h", t("${/route/params/nope}")),
          "pages.main.elements.label.props.deps.$template",
          'unknown route param "nope"',
        ],
        [
          "bare name outside a repeat",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: $template interpolation syntax under test
          definitionWith("load", "1h", t("${name}")),
          "pages.main.elements.label.props.deps.$template",
          'outside a repeat reads "/name"',
        ],
      );

      for (const [label, definition, path, message] of rejections) {
        const response = await ctx.api("POST", "/api/apps", {
          body: { name: `template refs ${label} ${ctx.nonce}`, definition },
        });
        if (response.status === 201) {
          created.push(String(asRecord(asRecord(response.json).app).id));
        }
        expectStatus(response, [400], `template read rejected: ${label}`);
        expect(
          asRecords(response.json, "issues").some(
            (found) => found.path === path && String(found.message).includes(message),
          ),
          `template read ${label} reports ${message} at ${path}: ${JSON.stringify(response.json)}`,
        );
      }
    } finally {
      for (const id of created) await ctx.api("DELETE", `/api/apps/${id}`);
    }
  },
};
