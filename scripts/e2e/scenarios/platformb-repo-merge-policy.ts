import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  Cleanup,
  callTool,
  expectToolError,
  expectToolOk,
  registerLead,
  registerWorker,
  retireAgent,
} from "./platformb-helpers";

const TEMPLATE = "system.agent.repository.merge_policy";

const record = {
  agentsMayMerge: false,
  autoMerge: { enabled: true, classes: ["docs", "bump"], riskyPaths: ["migrations/**"] },
  notify: { digestAt: "08:30", timezone: "Europe/Madrid" },
};

function guidelines(label: string, extra: Record<string, unknown> = {}) {
  return { prChecks: [`bun test ${label}`], mergeChecks: ["CI is green"], review: [], ...extra };
}

/** The merge-policy lines the worker prompt renders for a repo's guidelines. */
async function renderLines(ctx: ScenarioContext, vars: Record<string, string>): Promise<string> {
  const response = await ctx.api("POST", "/api/prompt-templates/render", {
    body: { eventType: TEMPLATE, variables: vars },
  });
  expectStatus(response, [200], "render the merge policy template");
  return String(asRecord(response.json).text);
}

/**
 * The per-repo merge-policy record inside `swarm_repos.guidelines`: schema defaults and bounds,
 * the lead-only write gate (create, update, drop-by-omission, resend-unchanged), the stored JSON,
 * and the registered prompt template that renders the Merge Policy lines.
 */
export const platformbRepoMergePolicy: Scenario = {
  name: "platformb-repo-merge-policy",
  order: 653,
  async run(ctx) {
    const cleanup = new Cleanup();
    const repoIds: string[] = [];
    let leadId: string | undefined;
    let workerConn: Awaited<ReturnType<ScenarioContext["connectMcp"]>> | undefined;
    let leadConn: Awaited<ReturnType<ScenarioContext["connectMcp"]>> | undefined;
    cleanup.add("close MCP connections", async () => {
      await workerConn?.close();
      await leadConn?.close();
    });
    cleanup.add("retire lead", () => retireAgent(ctx, leadId));
    cleanup.add("delete repos", async () => {
      for (const id of repoIds) await ctx.api("DELETE", `/api/repos/${id}`);
    });

    await cleanup.around(async () => {
      const workerId = await registerWorker(ctx, `e2e-repo-policy-worker-${ctx.nonce}`);
      leadId = await registerLead(ctx, `e2e-repo-policy-lead-${ctx.nonce}`);
      const name = `e2e-repo-policy-${ctx.nonce}`;
      const url = `https://git.example.invalid/e2e/${name}.git`;

      // --- validation: bounds and formats are refused before anything is stored.
      for (const [label, bad] of [
        ["threshold over 100", { autoMerge: { threshold: 101 } }],
        ["digestAt not HH:MM", { notify: { digestAt: "8:30" } }],
        ["base score not an integer", { autoMerge: { baseScores: { docs: 85.5 } } }],
      ] as const) {
        const response = await ctx.api("POST", "/api/repos", {
          body: { url, name, guidelines: guidelines("bad", { mergePolicy: bad }) },
        });
        expectStatus(response, [400], `create with ${label}`);
      }

      // --- a worker cannot create a repo with a record; the operator can.
      let response = await ctx.api("POST", "/api/repos", {
        agentId: workerId,
        body: { url, name, guidelines: guidelines("w", { mergePolicy: record }) },
      });
      expectStatus(response, [403], "worker creates a repo with a mergePolicy");
      response = await ctx.api("POST", "/api/repos", {
        body: { url, name, guidelines: guidelines("op", { mergePolicy: record }) },
      });
      expectStatus(response, [201], "operator creates a repo with a mergePolicy");
      const repoId = asString(asRecord(response.json).id, "repo id");
      repoIds.push(repoId);

      // Defaults are filled and the record is stored in the guidelines JSON, no new column.
      const row = ctx.db.get<{ guidelines: string }>(
        "SELECT guidelines FROM swarm_repos WHERE id = ?",
        [repoId],
      );
      const stored = asRecord(asRecord(JSON.parse(row?.guidelines ?? "{}")).mergePolicy);
      const auto = asRecord(stored.autoMerge);
      expect(
        stored.agentsMayMerge === false &&
          auto.enabled === true &&
          auto.threshold === 80 &&
          JSON.stringify(auto.classes) === JSON.stringify(["docs", "bump"]) &&
          JSON.stringify(auto.baseScores) === "{}" &&
          asRecord(stored.notify).dmWhenNotAutoMerging === true,
        `stored mergePolicy is ${JSON.stringify(stored)}`,
      );

      // --- update gate over HTTP.
      const read = async () =>
        asRecord(asRecord((await ctx.api("GET", `/api/repos/${repoId}`)).json));
      const changed = { ...record, autoMerge: { ...record.autoMerge, enabled: false } };
      response = await ctx.api("PUT", `/api/repos/${repoId}`, {
        agentId: workerId,
        body: { guidelines: guidelines("w", { mergePolicy: changed }) },
      });
      expectStatus(response, [403], "worker changes autoMerge.enabled");
      response = await ctx.api("PUT", `/api/repos/${repoId}`, {
        agentId: workerId,
        body: { guidelines: guidelines("w") },
      });
      expectStatus(response, [403], "worker drops the stored mergePolicy by omission");
      expect(
        asRecord(asRecord((await read()).guidelines).mergePolicy).autoMerge !== undefined,
        "A refused update changed the stored mergePolicy",
      );
      // Resending the stored record (read back, so defaults are included) edits the rest.
      const resend = asRecord((await read()).guidelines).mergePolicy;
      response = await ctx.api("PUT", `/api/repos/${repoId}`, {
        agentId: workerId,
        body: { guidelines: guidelines("w-edit", { mergePolicy: resend }) },
      });
      expectStatus(response, [200], "worker edits prChecks and resends the mergePolicy");
      expect(
        JSON.stringify(asRecord(asRecord(response.json).guidelines).prChecks) ===
          JSON.stringify(["bun test w-edit"]),
        "The worker's prChecks edit was not stored",
      );

      // --- update gate over MCP.
      workerConn = await ctx.connectMcp(workerId);
      leadConn = await ctx.connectMcp(leadId);
      expectToolError(
        await callTool(workerConn, "update-repo", {
          id: repoId,
          guidelines: guidelines("w", { mergePolicy: changed }),
        }),
        "Only lead agents can change allowMerge or mergePolicy",
        "update-repo mergePolicy by a worker",
      );
      const outcome = expectToolOk(
        await callTool(leadConn, "update-repo", {
          id: repoId,
          guidelines: guidelines("lead", { mergePolicy: changed }),
        }),
        "update-repo mergePolicy by a lead",
      );
      expect(
        asRecord(asRecord(asRecord(outcome.data.repo).guidelines).mergePolicy).autoMerge !==
          undefined &&
          asRecord(asRecord(asRecord(asRecord(outcome.data.repo).guidelines).mergePolicy).autoMerge)
            .enabled === false,
        "Lead update-repo did not store the new mergePolicy",
      );

      // --- the prompt lines come from the registered template: a repo with no record keeps
      // today's text, and the record adds its own line.
      const plain = await renderLines(ctx, {
        agents_may_merge: "Not allowed (default)",
        swarm_auto_merge: "",
        merge_checks: "\n- Before merging, verify:\n  - CI is green",
      });
      expect(
        plain ===
          "**Merge Policy:**\n- Auto-merge: Not allowed (default)\n- Before merging, verify:\n  - CI is green",
        `plain merge policy renders as ${JSON.stringify(plain)}`,
      );
      const withRecord = await renderLines(ctx, {
        agents_may_merge: "Not allowed (default)",
        swarm_auto_merge: "\n- Swarm auto-merge: on (minimum score 80); classes: docs, bump",
        merge_checks: "",
      });
      expect(withRecord.includes("- Swarm auto-merge: on (minimum score 80)"), "no record line");
    });
  },
};
