// Workflow engine, node types: every executor runs inside a real workflow run that
// reaches a terminal state. Two scenarios: the instant executors in one linear chain
// (this file's first export), and the async executors in one parallel run.
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  createWorkflow,
  GENERAL_CHANNEL_ID,
  hasStep,
  outputOf,
  pointLayaAtMock,
  registerWorker,
  stepOf,
  systemOneDecisionAnswer,
  triggerWorkflow,
  type WorkflowDef,
  waitForRun,
} from "./workflow-helpers";

/** Instant executors, one chain: every branch not taken must leave no step behind. */
export const workflowEngineInstantNodes: Scenario = {
  name: "workflow-engine-instant-nodes",
  order: 310,
  async run(ctx) {
    const marker = `chain-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "wf-chain");
    const scriptName = `e2e-wf-double-${ctx.nonce}`;

    // swarm-script resolves an agent-scoped script through the workflow creator.
    const upsert = await ctx.api("POST", "/api/scripts/upsert", {
      agentId: workerId,
      body: {
        name: scriptName,
        scope: "agent",
        description: "e2e: add one to the number",
        source:
          "export default async (args: { value: number }) => ({ value: Number(args.value) + 1 });",
      },
    });
    expectStatus(upsert, [200], "upsert the swarm-script");

    const cleanupLaya = await pointLayaAtMock(ctx);
    ctx.llm.setSystemOneResponder((body) =>
      systemOneDecisionAnswer(body, {
        choice: { team: "technical" },
        noul: { fit: 0.8 },
        score: { urgency: 1 },
      }),
    );
    ctx.llm.setChatResponder((request, schema) => {
      const input = JSON.stringify(request.input ?? request.messages ?? "");
      if (schema && JSON.stringify(schema).includes('"reasoning"')) {
        return { pass: true, reasoning: `looks right ${marker}`, confidence: 0.8 };
      }
      if (schema) return { label: `label-${marker}`, score: 7 };
      return `llm says ${marker} (${input.includes("42") ? "saw 42" : "no 42"})`;
    });

    try {
      const definition: WorkflowDef = {
        nodes: [
          {
            id: "n-prop",
            type: "property-match",
            config: {
              mode: "all",
              conditions: [
                { field: "trigger.kind", op: "eq", value: "alpha" },
                { field: "trigger.count", op: "gt", value: 2 },
                { field: "trigger.tags", op: "contains", value: "red" },
                { field: "trigger.tags", op: "not_contains", value: "blue" },
                { field: "trigger.note", op: "exists" },
              ],
            },
            next: { true: "n-code", false: "n-wrong-prop" },
          },
          {
            id: "n-wrong-prop",
            type: "script",
            config: { runtime: "bash", script: "echo wrong-prop-branch" },
          },
          {
            id: "n-code",
            type: "code-match",
            config: {
              code: "(input) => (input.trigger.count > 5 ? 'big' : 'small')",
              outputPorts: ["big", "small"],
            },
            next: { big: "n-big", small: "n-wrong-code" },
          },
          {
            id: "n-wrong-code",
            type: "script",
            config: { runtime: "bash", script: "echo wrong-code-branch" },
          },
          {
            id: "n-big",
            type: "script",
            config: {
              runtime: "bash",
              script: `echo '{"answer":41,"marker":"${marker}","items":[{"id":"a"},{"id":"b"}]}'`,
            },
            next: "n-swarm",
          },
          {
            id: "n-swarm",
            type: "swarm-script",
            inputs: { big: "n-big" },
            config: { scriptName, scope: "agent", args: { value: "{{big.answer}}" } },
            next: "n-llm-text",
          },
          {
            id: "n-llm-text",
            type: "raw-llm",
            inputs: { doubled: "n-swarm" },
            config: { prompt: "Describe the number {{doubled.result.value}} briefly." },
            next: "n-llm-json",
          },
          {
            id: "n-llm-json",
            type: "raw-llm",
            config: {
              prompt: "Label this run",
              schema: {
                type: "object",
                properties: { label: { type: "string" }, score: { type: "number" } },
                required: ["label", "score"],
              },
            },
            next: "n-validate-schema",
          },
          {
            id: "n-validate-schema",
            type: "validate",
            config: {
              targetNodeId: "n-big",
              schema: {
                type: "object",
                required: ["answer"],
                properties: { answer: { const: 41 } },
              },
            },
            next: { pass: "n-validate-llm", fail: "n-wrong-validate" },
          },
          {
            id: "n-wrong-validate",
            type: "script",
            config: { runtime: "bash", script: "echo wrong-validate-branch" },
          },
          {
            id: "n-validate-llm",
            type: "validate",
            config: { targetNodeId: "n-llm-text", prompt: "The text must mention the number." },
            next: { pass: "n-decide", fail: "n-wrong-validate" },
          },
          {
            id: "n-decide",
            type: "system-one-decision",
            inputs: { lead: "trigger.lead" },
            config: {
              provider: "laya",
              state: "{{lead}}",
              questions: {
                fit: {
                  type: "noul",
                  instructions: "Is this a real lead?",
                },
                team: {
                  type: "choice",
                  instructions: "Which team handles it?",
                  criteria: { billing: "Charges", technical: "Bugs and outages" },
                },
                urgency: {
                  type: "score",
                  instructions: "How urgent is it?",
                  criteria: ["low", "high"],
                },
              },
              returns: {
                fit: { type: "noul" },
                team: { type: "choice" },
                urgency: { type: "score" },
              },
              maxRetries: 0,
            },
            next: "n-route",
          },
          {
            id: "n-route",
            type: "code-match",
            inputs: { decided: "n-decide" },
            config: {
              code: "(input) => input.decided.answers.team.choice",
              outputPorts: ["billing", "technical"],
            },
            next: { technical: "n-foreach", billing: "n-wrong-route" },
          },
          {
            id: "n-wrong-route",
            type: "script",
            config: { runtime: "bash", script: "echo wrong-route-branch" },
          },
          {
            id: "n-foreach",
            type: "foreach",
            inputs: { items: "n-big.items" },
            config: {
              over: "{{items}}",
              itemKey: "id",
              body: {
                type: "script",
                config: { runtime: "bash", script: "echo item-$0", args: ["{{item.id}}"] },
              },
            },
            next: "n-notify-swarm",
          },
          {
            id: "n-notify-swarm",
            type: "notify",
            inputs: { fe: "n-foreach" },
            config: {
              channel: "swarm",
              target: GENERAL_CHANNEL_ID,
              template: `e2e chain ${marker} ok={{fe.okCount}}`,
            },
            next: "n-notify-slack",
          },
          {
            id: "n-notify-slack",
            type: "notify",
            config: { channel: "slack", target: "C0GENERAL0", template: `slack ${marker}` },
            next: "n-notify-email",
          },
          {
            id: "n-notify-email",
            type: "notify",
            config: { channel: "email", target: "ops@example.com", template: `email ${marker}` },
            next: "n-vcs",
          },
          {
            id: "n-vcs",
            type: "vcs",
            config: {
              action: "create-pr",
              provider: "github",
              repo: `desplega-ai/e2e-${ctx.nonce}`,
              title: `PR ${marker}`,
              body: "stub",
              branch: "feature/e2e",
              baseBranch: "main",
            },
          },
        ],
      };
      const workflowId = await createWorkflow(ctx, "wf-chain", definition, {}, workerId);
      const { runId, skipped } = await triggerWorkflow(
        ctx,
        workflowId,
        {
          kind: "alpha",
          count: 7,
          tags: ["red", "green"],
          note: "present",
          lead: { message: `please help ${marker}` },
        },
        { agentId: workerId },
      );
      expect(!skipped, "chain run was skipped");
      const detail = await waitForRun(ctx, runId, "completed", 60_000, "instant chain");

      // Branches not taken leave no step at all.
      for (const wrong of ["n-wrong-prop", "n-wrong-code", "n-wrong-validate", "n-wrong-route"]) {
        expect(!hasStep(detail, wrong), `the not-taken branch ${wrong} ran`);
      }
      expect(stepOf(detail, "n-prop").nextPort === "true", "property-match routed on port true");
      expect(stepOf(detail, "n-code").nextPort === "big", "code-match routed on port big");

      const prop = outputOf(detail, "n-prop");
      expect(prop.passed === true, "property-match passed");
      expect(asRecords(prop, "results").length === 5, "property-match reports every condition");
      const code = outputOf(detail, "n-code");
      expect(code.port === "big" && code.rawResult === "big", "code-match output");

      const big = outputOf(detail, "n-big");
      expect(big.exitCode === 0 && big.answer === 41, "script merged its JSON stdout");
      expect(big.marker === marker, "script output carries the marker");

      const swarm = outputOf(detail, "n-swarm");
      expect(swarm.scriptName === scriptName, "swarm-script reports its script name");
      expect(swarm.exitCode === 0, "swarm-script exit code");
      expect(asRecord(swarm.result).value === 42, "swarm-script computed 41 + 1");
      expect(typeof swarm.contentHash === "string", "swarm-script reports a content hash");

      const text = outputOf(detail, "n-llm-text");
      expect(
        String(text.result) === `llm says ${marker} (saw 42)`,
        `raw-llm text came from the mock: ${String(text.result)}`,
      );
      expect(typeof text.model === "string", "raw-llm reports the model");
      const structured = outputOf(detail, "n-llm-json");
      expect(
        asRecord(structured.result).label === `label-${marker}` &&
          asRecord(structured.result).score === 7,
        "raw-llm with a schema returned the scripted object",
      );
      const sent = ctx.llm.requestsTo("/responses");
      expect(
        sent.some((request) => JSON.stringify(request.body).includes("Describe the number 42")),
        "the engine sent the interpolated prompt to the inference host",
      );

      const validatedSchema = outputOf(detail, "n-validate-schema");
      expect(validatedSchema.pass === true && validatedSchema.confidence === 1, "schema validate");
      expect(stepOf(detail, "n-validate-schema").nextPort === "pass", "validate routed on pass");
      const validatedLlm = outputOf(detail, "n-validate-llm");
      expect(
        validatedLlm.pass === true && validatedLlm.reasoning === `looks right ${marker}`,
        "prompt validate used the LLM verdict",
      );

      const decided = outputOf(detail, "n-decide");
      const answers = asRecord(decided.answers);
      expect(asRecord(answers.team).choice === "technical", "decision picked technical");
      expect(asRecord(answers.fit).noul === 0.8, "decision noul answer");
      expect(asRecord(answers.urgency).score === 1, "decision score answer");
      expect(asRecord(decided.routing).model === "english", "decision keeps the laya checkpoint");
      const systemOneCalls = ctx.llm.requestsTo("/systemone");
      expect(systemOneCalls.length >= 1, "the decision reached the SystemOne mock");
      const call = systemOneCalls[systemOneCalls.length - 1]!;
      expect(call.headers.authorization === "Bearer e2e-laya-key", "decision sent the laya key");
      expect(
        JSON.stringify(asRecord(call.body).state).includes(marker),
        "decision sent the interpolated state",
      );
      expect(stepOf(detail, "n-route").nextPort === "technical", "route on the decided team");

      const foreach = outputOf(detail, "n-foreach");
      expect(foreach.okCount === 2 && foreach.failedCount === 0, "foreach counts");
      const results = asRecords(foreach, "results");
      expect(
        results.map((entry) => entry.itemKey).join(",") === "a,b" &&
          results.every((entry) => entry.status === "completed"),
        "foreach results per item",
      );
      expect(asRecord(results[0]?.output).stdout === "item-a", "foreach body ran per item");
      // Synthetic child steps carry the body type.
      const childTypes = ctx.db.query<{ nodeId: string; nodeType: string }>(
        "SELECT nodeId, nodeType FROM workflow_run_steps WHERE runId = ? AND nodeId LIKE 'n-foreach#%' ORDER BY nodeId",
        [runId],
      );
      expect(
        childTypes.length === 2 && childTypes.every((child) => child.nodeType === "script"),
        `foreach child rows: ${JSON.stringify(childTypes)}`,
      );

      const swarmNote = outputOf(detail, "n-notify-swarm");
      expect(swarmNote.sent === true && typeof swarmNote.messageId === "string", "swarm notify");
      const posted = ctx.db.get<{ content: string; agentId: string | null }>(
        "SELECT content, agentId FROM channel_messages WHERE id = ?",
        [asString(swarmNote.messageId, "swarm message id")],
      );
      expect(
        posted?.content === `e2e chain ${marker} ok=2`,
        `swarm channel message: ${posted?.content}`,
      );
      const slackNote = outputOf(detail, "n-notify-slack");
      expect(slackNote.sent === true, "slack notify reports sent");
      await ctx.slack.waitForMessage(
        (message) =>
          message.channel === "C0GENERAL0" && JSON.stringify(message).includes(`slack ${marker}`),
        { timeoutMs: 15_000 },
      );
      const emailNote = outputOf(detail, "n-notify-email");
      expect(emailNote.sent === false && emailNote.message === `email ${marker}`, "email stub");

      const vcs = outputOf(detail, "n-vcs");
      expect(
        typeof vcs.url === "string" &&
          vcs.url.startsWith(`https://github.com/desplega-ai/e2e-${ctx.nonce}/create-pr/stub-`),
        `vcs stub url: ${String(vcs.url)}`,
      );

      // Every executor type of the chain shows up in the step rows.
      const types = new Set(
        ctx.db
          .query<{ nodeType: string }>(
            "SELECT DISTINCT nodeType FROM workflow_run_steps WHERE runId = ?",
            [runId],
          )
          .map((row) => row.nodeType),
      );
      for (const type of [
        "property-match",
        "code-match",
        "script",
        "swarm-script",
        "raw-llm",
        "validate",
        "system-one-decision",
        "foreach",
        "notify",
        "vcs",
      ]) {
        expect(types.has(type), `no workflow_run_steps row of type ${type}`);
      }
    } finally {
      ctx.llm.setChatResponder(undefined);
      ctx.llm.setSystemOneResponder(undefined);
      await cleanupLaya();
    }
  },
};
