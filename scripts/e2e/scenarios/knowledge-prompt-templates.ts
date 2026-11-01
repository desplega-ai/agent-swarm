import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callTool,
  dbCount,
  expectToolError,
  expectToolOk,
  registerAgent,
  UUID,
} from "./knowledge-helpers";

type Json = Record<string, unknown>;

export const knowledgePromptTemplates: Scenario = {
  name: "knowledge-prompt-templates",
  order: 530,
  async run(ctx) {
    // Overrides are written at agent scope for dedicated agents, so no other scenario's prompts
    // change. Global scope is exercised on event types nothing renders.
    const agent = await registerAgent(ctx, "prompt-a");
    const otherAgent = await registerAgent(ctx, "prompt-b");
    const session = await ctx.connectMcp(agent);
    const cleanup: string[] = [];
    try {
      // ── Registry ────────────────────────────────────────────────────────────────────────────
      let response = await ctx.api("GET", "/api/prompt-templates/events");
      expectStatus(response, [200], "list template events");
      const events = asRecords(response.json, "events");
      expect(events.length > 10, "the registry must expose the code-defined event types");
      for (const event of events.slice(0, 5)) {
        expect(
          typeof event.eventType === "string" &&
            typeof event.header === "string" &&
            typeof event.defaultBody === "string" &&
            Array.isArray(event.variables) &&
            ["event", "system", "common", "task_lifecycle", "session"].includes(
              String(event.category),
            ),
          `event definition shape: ${JSON.stringify(event).slice(0, 200)}`,
        );
      }
      const definitions = new Map(events.map((event) => [String(event.eventType), event]));

      response = await ctx.api("GET", "/api/prompt-templates?isDefault=true&scope=global");
      expectStatus(response, [200], "list default templates");
      const defaults = asRecords(response.json, "templates");
      expect(defaults.length > 0, "no seeded default prompt templates");
      const seededDefault = defaults.find(
        (template) =>
          definitions.has(String(template.eventType)) &&
          String(definitions.get(String(template.eventType))?.defaultBody).length > 0,
      );
      expect(seededDefault, "no seeded default template matches a registry definition");
      const eventType = asString(seededDefault.eventType, "default eventType");
      const defaultId = asString(seededDefault.id, "default template id");
      const definition = asRecord(definitions.get(eventType));
      const secondDefault = defaults.find(
        (template) =>
          template.eventType !== eventType && definitions.has(String(template.eventType)),
      );
      expect(secondDefault, "need a second seeded default template");
      const secondEventType = asString(secondDefault.eventType, "second eventType");
      expect(
        seededDefault.isDefault === true &&
          seededDefault.scope === "global" &&
          seededDefault.state === "enabled" &&
          typeof seededDefault.defaultDrifted === "boolean",
        `seeded default template fields: ${JSON.stringify(seededDefault)}`,
      );

      response = await ctx.api("GET", `/api/prompt-templates?eventType=${eventType}`);
      expectStatus(response, [200], "filter templates by eventType");
      expect(
        asRecords(response.json, "templates").every((row) => row.eventType === eventType),
        "eventType filter",
      );
      response = await ctx.api("GET", `/api/prompt-templates/${defaultId}`);
      expectStatus(response, [200], "get a template with history");
      let detail = asRecord(response.json);
      expect(asRecord(detail.template).id === defaultId, "get template");
      const history = asRecords(detail, "history");
      expect(
        history.length >= 1 &&
          history.every(
            (row, index) =>
              index === 0 || (row.version as number) <= (history[index - 1]!.version as number),
          ),
        "history is newest first",
      );
      response = await ctx.api("GET", `/api/prompt-templates/${crypto.randomUUID()}`);
      expectStatus(response, [404], "get unknown template");

      // ── Preview (dry run) ───────────────────────────────────────────────────────────────────
      response = await ctx.api("POST", "/api/prompt-templates/preview", {
        body: {
          eventType,
          body: "Hello {{who}} from {{where}}.",
          variables: { who: `tester-${ctx.nonce}` },
        },
      });
      expectStatus(response, [200], "preview with a custom body");
      let preview = asRecord(response.json);
      expect(
        String(preview.rendered).includes(`Hello tester-${ctx.nonce} from .`),
        `preview renders variables and blanks unresolved tokens: ${String(preview.rendered)}`,
      );
      expect(
        Array.isArray(preview.unresolved) && (preview.unresolved as string[]).includes("where"),
        "preview unresolved list",
      );
      if (String(definition.header).length > 0) {
        expect(
          String(preview.rendered).startsWith(String(definition.header)),
          "preview prefixes the event header",
        );
      }
      response = await ctx.api("POST", "/api/prompt-templates/preview", { body: { eventType } });
      expectStatus(response, [200], "preview with the default body");
      preview = asRecord(response.json);
      expect(String(preview.rendered).length > 0, "default body preview is not empty");
      response = await ctx.api("POST", "/api/prompt-templates/preview", {
        body: { eventType: `e2e.unregistered.${ctx.nonce}`, body: "plain" },
      });
      expectStatus(response, [200], "preview of an unregistered event type");
      expect(asRecord(response.json).rendered === "plain", "unregistered preview renders the body");
      response = await ctx.api("POST", "/api/prompt-templates/preview", { body: {} });
      expectStatus(response, [400], "preview without eventType");

      // ── Agent-scope override: create, resolve, render, update, checkout ────────────────────
      response = await ctx.api("PUT", "/api/prompt-templates", {
        body: {
          eventType,
          scope: "agent",
          scopeId: agent,
          body: "Override one for {{marker}}.",
          changedBy: "e2e-operator",
          changeReason: "e2e: first override",
        },
      });
      expectStatus(response, [200], "create an agent-scope override");
      let template = asRecord(asRecord(response.json).template);
      const overrideId = asString(template.id, "override id");
      expect(UUID.test(overrideId), "override id is a UUID");
      expect(
        template.scope === "agent" &&
          template.scopeId === agent &&
          template.version === 1 &&
          template.isDefault === false &&
          template.state === "enabled" &&
          template.eventType === eventType,
        `override fields: ${JSON.stringify(template)}`,
      );
      expect(
        dbCount(
          ctx,
          "SELECT count(*) AS n FROM prompt_template_history WHERE templateId = ? AND changeReason = ?",
          [overrideId, "e2e: first override"],
        ) === 1,
        "history row for the first override",
      );
      expect(
        ctx.db.get<{ changedBy: string | null }>(
          "SELECT changedBy FROM prompt_template_history WHERE templateId = ? AND version = 1",
          [overrideId],
        )?.changedBy === "e2e-operator",
        "history records changedBy",
      );

      response = await ctx.api(
        "GET",
        `/api/prompt-templates/resolved?eventType=${eventType}&agentId=${agent}`,
      );
      expectStatus(response, [200], "resolve with an agent override");
      let resolved = asRecord(response.json);
      expect(
        asRecord(asRecord(resolved.dbResult).template).id === overrideId,
        "the agent override must win the scope chain",
      );
      expect(asRecord(resolved.definition).eventType === eventType, "resolved definition");
      expect(asRecord(resolved.resolution).scope === "agent", "resolution reports the agent scope");
      response = await ctx.api("GET", `/api/prompt-templates/resolved?eventType=${eventType}`);
      expectStatus(response, [200], "resolve without an agent");
      resolved = asRecord(response.json);
      expect(
        asRecord(asRecord(resolved.dbResult).template).id === defaultId,
        "without an agent the global default resolves",
      );
      response = await ctx.api(
        "GET",
        `/api/prompt-templates/resolved?eventType=e2e.unregistered.${ctx.nonce}`,
      );
      expectStatus(response, [200], "resolve an unregistered event");
      resolved = asRecord(response.json);
      expect(resolved.dbResult === null && resolved.definition === null, "nothing resolves");
      response = await ctx.api("GET", "/api/prompt-templates/resolved");
      expectStatus(response, [400], "resolve without eventType");

      response = await ctx.api("POST", "/api/prompt-templates/render", {
        body: { eventType, variables: { marker: ctx.nonce }, agentId: agent },
      });
      expectStatus(response, [200], "render with the override");
      let rendered = asRecord(response.json);
      expect(
        String(rendered.text).includes(`Override one for ${ctx.nonce}.`) &&
          rendered.templateId === overrideId &&
          rendered.scope === "agent" &&
          rendered.skipped === false,
        `render result: ${JSON.stringify(rendered).slice(0, 300)}`,
      );
      response = await ctx.api("POST", "/api/prompt-templates/render", {
        body: { eventType, variables: { marker: ctx.nonce }, agentId: otherAgent },
      });
      expectStatus(response, [200], "render for an agent without an override");
      rendered = asRecord(response.json);
      expect(
        rendered.templateId === defaultId && !String(rendered.text).includes("Override one"),
        "an override is scoped to its agent",
      );
      response = await ctx.api("POST", "/api/prompt-templates/render", { body: {} });
      expectStatus(response, [400], "render without eventType");

      response = await ctx.api("PUT", "/api/prompt-templates", {
        body: {
          eventType,
          scope: "agent",
          scopeId: agent,
          body: "Override two for {{marker}}.",
          changeReason: "e2e: second override",
        },
      });
      expectStatus(response, [200], "update the override");
      template = asRecord(asRecord(response.json).template);
      expect(template.id === overrideId && template.version === 2, "an upsert bumps the version");
      response = await ctx.api("GET", `/api/prompt-templates/${overrideId}`);
      detail = asRecord(response.json);
      expect(
        asRecords(detail, "history")
          .map((row) => row.version)
          .join(",") === "2,1",
        "history keeps both versions, newest first",
      );

      response = await ctx.api("POST", `/api/prompt-templates/${overrideId}/checkout`, {
        body: { version: 1 },
      });
      expectStatus(response, [200], "checkout version 1");
      template = asRecord(asRecord(response.json).template);
      expect(
        template.body === "Override one for {{marker}}." && template.version === 3,
        "checkout restores the old body as a new version",
      );
      expect(
        dbCount(
          ctx,
          "SELECT count(*) AS n FROM prompt_template_history WHERE templateId = ? AND changeReason = ?",
          [overrideId, "Checked out from version 1"],
        ) === 1,
        "checkout writes a history row",
      );
      response = await ctx.api("POST", `/api/prompt-templates/${overrideId}/checkout`, {
        body: { version: 99 },
      });
      expectStatus(response, [404], "checkout of a missing version");
      response = await ctx.api("POST", `/api/prompt-templates/${crypto.randomUUID()}/checkout`, {
        body: { version: 1 },
      });
      expectStatus(response, [404], "checkout of an unknown template");
      response = await ctx.api("POST", `/api/prompt-templates/${overrideId}/checkout`, {
        body: {},
      });
      expectStatus(response, [400], "checkout without a version");

      // States: skip_event suppresses the event, default_prompt_fallback falls through.
      response = await ctx.api("PUT", "/api/prompt-templates", {
        body: { eventType, scope: "agent", scopeId: agent, state: "skip_event", body: "unused" },
      });
      expectStatus(response, [200], "set skip_event");
      response = await ctx.api(
        "GET",
        `/api/prompt-templates/resolved?eventType=${eventType}&agentId=${agent}`,
      );
      expect(
        asRecord(asRecord(response.json).dbResult).skip === true,
        "skip_event resolves to skip",
      );
      response = await ctx.api("POST", "/api/prompt-templates/render", {
        body: { eventType, agentId: agent },
      });
      expect(
        asRecord(response.json).skipped === true && asRecord(response.json).text === "",
        "render honours skip_event",
      );
      response = await ctx.api("PUT", "/api/prompt-templates", {
        body: {
          eventType,
          scope: "agent",
          scopeId: agent,
          state: "default_prompt_fallback",
          body: "unused",
        },
      });
      expectStatus(response, [200], "set default_prompt_fallback");
      response = await ctx.api("POST", "/api/prompt-templates/render", {
        body: { eventType, agentId: agent },
      });
      expect(
        asRecord(response.json).templateId === defaultId,
        "default_prompt_fallback falls through to the global default",
      );

      // PUT validation.
      for (const [label, body] of [
        ["global with a scopeId", { eventType, scope: "global", scopeId: agent, body: "x" }],
        ["agent without a scopeId", { eventType, scope: "agent", body: "x" }],
        ["repo without a scopeId", { eventType, scope: "repo", body: "x" }],
        ["empty eventType", { eventType: "", body: "x" }],
        ["invalid scope", { eventType, scope: "planet", body: "x" }],
        ["invalid state", { eventType, scope: "agent", scopeId: agent, state: "maybe", body: "x" }],
        ["missing body", { eventType, scope: "agent", scopeId: agent }],
      ] as const) {
        response = await ctx.api("PUT", "/api/prompt-templates", { body });
        expectStatus(response, [400], `upsert: ${label}`);
      }

      // Reset: a second override goes back to the code default and then cannot be deleted.
      response = await ctx.api("PUT", "/api/prompt-templates", {
        body: { eventType: secondEventType, scope: "agent", scopeId: agent, body: "Custom {{x}}" },
      });
      expectStatus(response, [200], "create a second override");
      const secondOverrideId = asString(
        asRecord(asRecord(response.json).template).id,
        "second override id",
      );
      response = await ctx.api("POST", `/api/prompt-templates/${secondOverrideId}/reset`);
      expectStatus(response, [200], "reset to the code default");
      template = asRecord(asRecord(response.json).template);
      expect(
        template.body === asRecord(definitions.get(secondEventType)).defaultBody &&
          template.isDefault === true &&
          template.state === "enabled" &&
          template.version === 2 &&
          template.defaultDrifted === false,
        `reset template: ${JSON.stringify(template).slice(0, 300)}`,
      );
      response = await ctx.api("DELETE", `/api/prompt-templates/${secondOverrideId}`);
      expectStatus(response, [400], "a default template cannot be deleted");
      response = await ctx.api("POST", `/api/prompt-templates/${crypto.randomUUID()}/reset`);
      expectStatus(response, [404], "reset an unknown template");

      // ── Custom event types: global scope, wildcard resolution, no code default ──────────────
      const customEvent = `e2e.${ctx.nonce}.child`;
      const wildcardEvent = `e2e.${ctx.nonce}.*`;
      response = await ctx.api("PUT", "/api/prompt-templates", {
        body: {
          eventType: wildcardEvent,
          body: "Wildcard {{value}}",
          changeReason: "e2e wildcard",
        },
      });
      expectStatus(response, [200], "create a global wildcard template");
      template = asRecord(asRecord(response.json).template);
      const wildcardId = asString(template.id, "wildcard template id");
      cleanup.push(wildcardId);
      expect(
        template.scope === "global" && template.scopeId === null && template.isDefault === false,
        "global template fields",
      );
      response = await ctx.api("GET", `/api/prompt-templates/resolved?eventType=${customEvent}`);
      expect(
        asRecord(asRecord(asRecord(response.json).dbResult).template).id === wildcardId,
        "a wildcard template resolves for a matching event type",
      );
      response = await ctx.api("POST", "/api/prompt-templates/render", {
        body: { eventType: customEvent, variables: { value: ctx.nonce } },
      });
      expect(
        String(asRecord(response.json).text).includes(`Wildcard ${ctx.nonce}`),
        "wildcard render",
      );
      response = await ctx.api(
        "GET",
        `/api/prompt-templates?eventType=${encodeURIComponent(wildcardEvent)}&scope=global&isDefault=false`,
      );
      expect(
        asRecords(response.json, "templates").length === 1,
        "list filters scope and isDefault",
      );
      response = await ctx.api("GET", `/api/prompt-templates?scope=agent&scopeId=${agent}`);
      const agentTemplates = asRecords(response.json, "templates");
      expect(
        agentTemplates.some((row) => row.id === overrideId) &&
          agentTemplates.every((row) => row.scopeId === agent),
        "list filters scope and scopeId",
      );
      response = await ctx.api("POST", `/api/prompt-templates/${wildcardId}/reset`);
      expectStatus(response, [404], "reset a template with no code default");

      // ── MCP tools ───────────────────────────────────────────────────────────────────────────
      let outcome = expectToolOk(
        await callTool(session, "set-prompt-template", {
          eventType: `e2e.${ctx.nonce}.tool`,
          scope: "agent",
          scopeId: agent,
          body: "Tool template {{name}}",
          changeReason: "e2e: tool set",
        }),
        "set-prompt-template",
      );
      const toolTemplate = asRecord(outcome.data.template);
      const toolTemplateId = asString(toolTemplate.id, "tool template id");
      cleanup.push(toolTemplateId);
      expect(toolTemplate.version === 1 && toolTemplate.scope === "agent", "tool template fields");
      expect(
        ctx.db.get<{ changedBy: string | null }>(
          "SELECT changedBy FROM prompt_template_history WHERE templateId = ? AND version = 1",
          [toolTemplateId],
        )?.changedBy === agent,
        "the tool records the calling agent as changedBy",
      );
      outcome = expectToolOk(
        await callTool(session, "set-prompt-template", {
          eventType: `e2e.${ctx.nonce}.tool`,
          scope: "agent",
          scopeId: agent,
          body: "Tool template v2 {{name}}",
          state: "enabled",
        }),
        "set-prompt-template update",
      );
      expect(asRecord(outcome.data.template).version === 2, "set-prompt-template bumps version");
      expectToolError(
        await callTool(session, "set-prompt-template", {
          eventType: `e2e.${ctx.nonce}.tool`,
          scope: "repo",
          body: "needs a scope id",
        }),
        "set-prompt-template repo scope without scopeId",
        /scopeId is required/i,
      );
      outcome = expectToolOk(
        await callTool(session, "get-prompt-template", { id: toolTemplateId }),
        "get-prompt-template",
      );
      expect(asRecord(outcome.data.template).id === toolTemplateId, "get-prompt-template");
      expect((outcome.data.history as unknown[]).length === 2, "get-prompt-template history");
      outcome = expectToolOk(
        await callTool(session, "get-prompt-template", { id: overrideId }),
        "get-prompt-template with registry variables",
      );
      expect(
        Array.isArray(outcome.data.variables) &&
          (outcome.data.variables as unknown[]).length ===
            (definition.variables as unknown[]).length,
        "get-prompt-template returns the code-defined variables",
      );
      expectToolError(
        await callTool(session, "get-prompt-template", { id: crypto.randomUUID() }),
        "get-prompt-template unknown",
        /not found/i,
      );
      outcome = expectToolOk(
        await callTool(session, "list-prompt-templates", {
          scope: "agent",
          scopeId: agent,
          isDefault: false,
        }),
        "list-prompt-templates",
      );
      const toolListed = outcome.data.templates as Json[];
      expect(
        outcome.data.count === toolListed.length &&
          toolListed.some((row) => row.id === toolTemplateId) &&
          toolListed.every((row) => row.scopeId === agent && row.isDefault === false),
        "list-prompt-templates filters",
      );
      outcome = expectToolOk(
        await callTool(session, "list-prompt-templates", { eventType: `e2e.none.${ctx.nonce}` }),
        "list-prompt-templates without matches",
      );
      expect(outcome.data.count === 0, "list-prompt-templates count for no match");
      outcome = expectToolOk(
        await callTool(session, "preview-prompt-template", {
          eventType: `e2e.${ctx.nonce}.tool`,
          body: "Preview {{a}} and {{b}}",
          variables: { a: "one" },
        }),
        "preview-prompt-template",
      );
      expect(
        outcome.data.rendered === "Preview one and " &&
          JSON.stringify(outcome.data.unresolved) === JSON.stringify(["b"]),
        `preview-prompt-template result: ${JSON.stringify(outcome.data).slice(0, 200)}`,
      );
      expectToolError(
        await callTool(session, "delete-prompt-template", { id: crypto.randomUUID() }),
        "delete-prompt-template unknown",
        /not found/i,
      );
      expectToolError(
        await callTool(session, "delete-prompt-template", { id: secondOverrideId }),
        "delete-prompt-template of a default template",
        /default/i,
      );
      expectToolOk(
        await callTool(session, "delete-prompt-template", { id: toolTemplateId }),
        "delete-prompt-template",
      );
      cleanup.splice(cleanup.indexOf(toolTemplateId), 1);
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM prompt_templates WHERE id = ?", [
          toolTemplateId,
        ]) === 0,
        "delete-prompt-template left the row behind",
      );

      // ── Delete over HTTP ────────────────────────────────────────────────────────────────────
      response = await ctx.api("DELETE", `/api/prompt-templates/${overrideId}`);
      expectStatus(response, [200], "delete the override");
      expect(asRecord(response.json).deleted === true, "delete body");
      response = await ctx.api("GET", `/api/prompt-templates/${overrideId}`);
      expectStatus(response, [404], "get a deleted template");
      response = await ctx.api("DELETE", `/api/prompt-templates/${overrideId}`);
      expectStatus(response, [404], "delete a template twice");
      response = await ctx.api("POST", "/api/prompt-templates/render", {
        body: { eventType, agentId: agent },
      });
      expect(
        asRecord(response.json).templateId === defaultId,
        "after the delete the global default resolves again",
      );
      response = await ctx.api("DELETE", `/api/prompt-templates/${defaultId}`);
      expectStatus(response, [400], "the seeded default template cannot be deleted");
    } finally {
      for (const id of cleanup) await ctx.api("DELETE", `/api/prompt-templates/${id}`);
      await session.close();
    }
  },
};
