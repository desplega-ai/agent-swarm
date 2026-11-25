import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  CATALOG_TOPICS,
  catalogAction,
  catalogComponent,
  catalogIndex,
  catalogTopic,
} from "@/apps/catalog-reference";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerAppCatalogTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-catalog",
    {
      title: "App component catalog",
      description:
        'What an app page may contain, from the catalog the server validates against. No args: every component (one line, child slots) and action type. component: "Chart": its description, slots and props schema (prop: "columns" drills into one prop). action: "app.mutate": that action step\'s params. topic: "expressions": the binding reference ($state roots, route params and $param, $template, repeat/$item, watch, OnEnter.everyMs, visibility). Read this instead of guessing props.',
      annotations: { readOnlyHint: true },
      rbac: { ungated: "static catalog of the app vocabulary; holds no app data" },
      inputSchema: z.object({
        component: z.string().min(1).optional().describe("Component type, e.g. Chart."),
        prop: z.string().min(1).optional().describe("With component: return one prop's schema."),
        action: z.string().min(1).optional().describe("Action step type, e.g. app.mutate."),
        topic: z.enum(CATALOG_TOPICS).optional().describe("Reference topic."),
      }),
      outputSchema: swarmToolOutputSchema({
        components: z.unknown().optional(),
        actions: z.unknown().optional(),
        component: z.string().optional(),
        action: z.string().optional(),
        prop: z.string().optional(),
        description: z.string().optional(),
        slots: z.array(z.string()).optional(),
        props: z.unknown().optional(),
        params: z.unknown().optional(),
        schema: z.unknown().optional(),
        required: z.boolean().optional(),
        detail: z.string().optional(),
        topic: z.string().optional(),
        content: z.string().optional(),
        closest: z.array(z.string()).optional(),
      }),
    },
    async ({ component, prop, action, topic }) => {
      const given = [component, action, topic].filter((value) => value !== undefined).length;
      if (given > 1) return toolErr("Give at most one of component, action or topic.");
      if (prop !== undefined && component === undefined) return toolErr("prop needs component.");
      if (topic !== undefined) {
        const content = catalogTopic(topic);
        return toolOk(`App reference: ${topic}.`, {
          details: content,
          data: { topic, content },
          omitStructuredDetails: true,
        });
      }
      const lookup =
        component !== undefined
          ? catalogComponent(component, prop)
          : action !== undefined
            ? catalogAction(action)
            : { ok: true as const, value: catalogIndex() };
      if (!lookup.ok) {
        return toolErr(`${lookup.message}; closest: ${lookup.closest.join(", ")}.`, {
          data: { closest: lookup.closest },
        });
      }
      const label = component ?? action ?? "index";
      return toolOk(`App catalog: ${prop ? `${label}.${prop}` : label}.`, {
        details: JSON.stringify(lookup.value),
        data: lookup.value,
        // details is the compact JSON of data: the structured channel already carries data.
        omitStructuredDetails: true,
      });
    },
  );
};
