import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

type Guidelines = {
  prChecks: string[];
  mergeChecks: string[];
  review: string[];
  allowMerge?: boolean;
};

function guidelines(label: string, allowMerge?: boolean): Guidelines {
  return {
    prChecks: [`bun test ${label}`],
    mergeChecks: ["CI is green"],
    review: [`Check ${label}`],
    ...(allowMerge === undefined ? {} : { allowMerge }),
  };
}

async function createRepo(
  ctx: ScenarioContext,
  body: Record<string, unknown>,
  label: string,
  agentId?: string,
): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", "/api/repos", { body, agentId });
  expectStatus(response, [201], label);
  return asRecord(response.json);
}

async function readRepo(ctx: ScenarioContext, id: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/repos/${id}`);
  expectStatus(response, [200], `read repo ${id}`);
  return asRecord(response.json);
}

/**
 * Repo records over HTTP and MCP. A repo is a record (a git URL string or a local path): nothing
 * clones, so the scenario covers create, list filters, get, update, the allowMerge policy gate,
 * the get-repos and update-repo tools, and delete.
 */
export const platformbRepos: Scenario = {
  name: "platformb-repos",
  order: 650,
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
      const workerId = await registerWorker(ctx, `e2e-platformb-repo-worker-${ctx.nonce}`);
      leadId = await registerLead(ctx, `e2e-platformb-repo-lead-${ctx.nonce}`);

      // --- create: a git URL string with every default, then a local path with every field set.
      const urlName = `e2e-repo-url-${ctx.nonce}`;
      const urlRepo = await createRepo(
        ctx,
        { url: `https://git.example.invalid/e2e/${urlName}.git`, name: urlName },
        "create repo from a git URL",
      );
      const urlId = asString(urlRepo.id, "URL repo id");
      repoIds.push(urlId);
      expect(UUID.test(urlId), `Repo id ${urlId} is not a UUID`);
      expect(
        urlRepo.clonePath === `/workspace/personal/repos/${urlName}`,
        `Default clonePath is ${String(urlRepo.clonePath)}`,
      );
      expect(urlRepo.defaultBranch === "main", "Default branch is not main");
      expect(urlRepo.autoClone === true, "autoClone does not default to true");
      expect(urlRepo.guidelines === null, "A repo created without guidelines has guidelines");
      // FINDING: SwarmRepoSchema documents `hooks` as defaulting to { enabled: false } (and the
      // update-repo tool text calls { enabled: true } an opt-in), but createSwarmRepo stores
      // { enabled: true } when the body omits hooks.
      expect(asRecord(urlRepo.hooks).enabled === true, "Default hooks differ from enabled: true");
      expect(
        typeof urlRepo.createdAt === "string" && typeof urlRepo.lastUpdatedAt === "string",
        "Repo has no timestamps",
      );

      const localName = `e2e-repo-local-${ctx.nonce}`;
      const localUrl = `/tmp/e2e-platformb-${ctx.nonce}/local-checkout`;
      const localClonePath = `/workspace/e2e/${localName}`;
      const localRepo = await createRepo(
        ctx,
        {
          url: localUrl,
          name: localName,
          clonePath: localClonePath,
          defaultBranch: "develop",
          autoClone: false,
          hooks: { enabled: false },
          guidelines: guidelines("local"),
        },
        "create repo from a local path",
      );
      const localId = asString(localRepo.id, "local repo id");
      repoIds.push(localId);
      expect(
        localRepo.url === localUrl &&
          localRepo.clonePath === localClonePath &&
          localRepo.defaultBranch === "develop" &&
          localRepo.autoClone === false &&
          asRecord(localRepo.hooks).enabled === false,
        `Local repo did not keep its fields: ${JSON.stringify(localRepo)}`,
      );
      const localGuidelines = asRecord(localRepo.guidelines);
      expect(
        localGuidelines.allowMerge === false &&
          JSON.stringify(localGuidelines.prChecks) === JSON.stringify([`bun test local`]),
        `Guidelines were stored as ${JSON.stringify(localGuidelines)}`,
      );

      // The row is on disk with the same fields.
      const row = ctx.db.get<{
        url: string;
        name: string;
        clonePath: string;
        defaultBranch: string;
        autoClone: number;
        hooks: string;
        guidelines: string | null;
      }>(
        "SELECT url, name, clonePath, defaultBranch, autoClone, hooks, guidelines FROM swarm_repos WHERE id = ?",
        [localId],
      );
      expect(row, "Local repo is not in swarm_repos");
      expect(
        row.url === localUrl &&
          row.name === localName &&
          row.autoClone === 0 &&
          row.defaultBranch === "develop" &&
          JSON.parse(row.hooks).enabled === false &&
          JSON.parse(row.guidelines ?? "{}").review[0] === "Check local",
        `swarm_repos row differs from the API: ${JSON.stringify(row)}`,
      );

      // --- create negatives
      let response = await ctx.api("POST", "/api/repos", { body: { url: "https://x.invalid/a" } });
      expectStatus(response, [400], "reject a repo without a name");
      response = await ctx.api("POST", "/api/repos", { body: { url: "", name: "no-url" } });
      expectStatus(response, [400], "reject a repo with an empty url");
      response = await ctx.api("POST", "/api/repos", {
        body: {
          url: "https://x.invalid/over",
          name: `e2e-repo-over-${ctx.nonce}`,
          guidelines: {
            prChecks: Array.from({ length: 51 }, (_, index) => `check ${index}`),
            mergeChecks: [],
            review: [],
          },
        },
      });
      expectStatus(response, [400], "reject more than 50 guideline entries");
      for (const [label, body] of [
        ["url", { url: localUrl, name: `e2e-repo-dup-a-${ctx.nonce}` }],
        ["name", { url: `https://x.invalid/dup-b-${ctx.nonce}`, name: localName }],
        [
          "clonePath",
          {
            url: `https://x.invalid/dup-c-${ctx.nonce}`,
            name: `e2e-repo-dup-c-${ctx.nonce}`,
            clonePath: localClonePath,
          },
        ],
      ] as const) {
        response = await ctx.api("POST", "/api/repos", { body });
        expectStatus(response, [409], `reject a duplicate ${label}`);
        expect(
          String(asRecord(response.json).error).includes("already exists"),
          `Duplicate ${label} error is ${String(asRecord(response.json).error)}`,
        );
      }

      // --- list and filters
      response = await ctx.api("GET", "/api/repos");
      expectStatus(response, [200], "list repos");
      let listed = asRecords(response.json, "repos");
      expect(
        listed.some((repo) => repo.id === urlId) && listed.some((repo) => repo.id === localId),
        "Repo list omits a repo created by this scenario",
      );
      response = await ctx.api("GET", `/api/repos?name=${encodeURIComponent(localName)}`);
      expectStatus(response, [200], "list repos by name");
      listed = asRecords(response.json, "repos");
      expect(
        listed.length === 1 && listed[0]?.id === localId,
        `Name filter returned ${listed.length} repos`,
      );
      response = await ctx.api("GET", "/api/repos?autoClone=false");
      expectStatus(response, [200], "list repos with autoClone=false");
      listed = asRecords(response.json, "repos");
      expect(
        listed.every((repo) => repo.autoClone === false) &&
          listed.some((repo) => repo.id === localId),
        "autoClone=false filter returned an autoClone repo or omitted the local repo",
      );
      response = await ctx.api("GET", "/api/repos?autoClone=true");
      listed = asRecords(response.json, "repos");
      expect(
        listed.every((repo) => repo.autoClone === true) &&
          listed.some((repo) => repo.id === urlId) &&
          !listed.some((repo) => repo.id === localId),
        "autoClone=true filter is wrong",
      );
      expectStatus(await ctx.api("GET", "/api/repos?autoClone=maybe"), [400], "reject bad filter");

      // --- get
      const fetched = await readRepo(ctx, localId);
      expect(
        JSON.stringify(fetched) === JSON.stringify(localRepo),
        "GET /api/repos/{id} differs from the create response",
      );
      expectStatus(await ctx.api("GET", `/api/repos/${MISSING_ID}`), [404], "get a missing repo");
      expectStatus(await ctx.api("GET", "/api/repos/not-a-uuid"), [400], "get a repo by a bad id");

      // --- update: partial fields, null hooks and guidelines, duplicates, missing id.
      response = await ctx.api("PUT", `/api/repos/${urlId}`, {
        body: {
          defaultBranch: "trunk",
          autoClone: false,
          hooks: null,
          guidelines: guidelines("url"),
        },
      });
      expectStatus(response, [200], "update the URL repo");
      const updated = asRecord(response.json);
      expect(
        updated.id === urlId &&
          updated.defaultBranch === "trunk" &&
          updated.autoClone === false &&
          asRecord(updated.hooks).enabled === false &&
          asRecord(updated.guidelines).allowMerge === false &&
          updated.name === urlName &&
          updated.createdAt === urlRepo.createdAt,
        `Update response is ${JSON.stringify(updated)}`,
      );
      expect(
        Date.parse(String(updated.lastUpdatedAt)) >= Date.parse(String(urlRepo.lastUpdatedAt)),
        "lastUpdatedAt went backwards",
      );
      const stored = ctx.db.get<{ defaultBranch: string; hooks: string | null }>(
        "SELECT defaultBranch, hooks FROM swarm_repos WHERE id = ?",
        [urlId],
      );
      expect(
        stored?.defaultBranch === "trunk" &&
          (stored.hooks === null || !JSON.parse(stored.hooks).enabled),
        "Update was not persisted to swarm_repos",
      );
      response = await ctx.api("PUT", `/api/repos/${urlId}`, { body: { name: localName } });
      expectStatus(response, [409], "reject renaming onto an existing repo");
      expectStatus(
        await ctx.api("PUT", `/api/repos/${MISSING_ID}`, { body: { name: "ghost" } }),
        [404],
        "update a missing repo",
      );
      response = await ctx.api("PUT", `/api/repos/${urlId}`, { body: { guidelines: null } });
      expectStatus(response, [200], "clear guidelines");
      expect(asRecord(response.json).guidelines === null, "guidelines: null did not clear them");

      // --- allowMerge is lead, operator or user only.
      response = await ctx.api("PUT", `/api/repos/${urlId}`, {
        agentId: workerId,
        body: { guidelines: guidelines("worker", true) },
      });
      expectStatus(response, [403], "worker cannot turn allowMerge on");
      expect(
        String(asRecord(response.json).error).includes("lead agent, operator, or user"),
        `allowMerge refusal is ${String(asRecord(response.json).error)}`,
      );
      expect(
        asRecord((await readRepo(ctx, urlId)).guidelines ?? {}).allowMerge !== true,
        "A refused allowMerge change was stored",
      );
      response = await ctx.api("PUT", `/api/repos/${urlId}`, {
        agentId: workerId,
        body: { guidelines: guidelines("worker", false) },
      });
      expectStatus(response, [200], "worker can edit guidelines without changing allowMerge");
      response = await ctx.api("PUT", `/api/repos/${urlId}`, {
        body: { guidelines: guidelines("operator", true) },
      });
      expectStatus(response, [200], "operator turns allowMerge on");
      expect(asRecord(asRecord(response.json).guidelines).allowMerge === true, "allowMerge is off");
      response = await ctx.api("POST", "/api/repos", {
        agentId: workerId,
        body: {
          url: `https://x.invalid/worker-${ctx.nonce}`,
          name: `e2e-repo-worker-${ctx.nonce}`,
          guidelines: guidelines("worker-create", true),
        },
      });
      expectStatus(response, [403], "worker cannot create a repo with allowMerge on");
      const leadRepo = await createRepo(
        ctx,
        {
          url: `https://x.invalid/lead-${ctx.nonce}`,
          name: `e2e-repo-lead-${ctx.nonce}`,
          guidelines: guidelines("lead-create", true),
        },
        "lead creates a repo with allowMerge on",
        leadId,
      );
      const leadRepoId = asString(leadRepo.id, "lead repo id");
      repoIds.push(leadRepoId);
      expect(asRecord(leadRepo.guidelines).allowMerge === true, "Lead repo lost allowMerge");

      // --- MCP get-repos
      workerConn = await ctx.connectMcp(workerId);
      leadConn = await ctx.connectMcp(leadId);
      let outcome = expectToolOk(await callTool(workerConn, "get-repos", {}), "get-repos");
      let repos = asRecords(outcome.data, "repos");
      expect(
        repos.some((repo) => repo.id === urlId) &&
          repos.some((repo) => repo.id === localId) &&
          outcome.data.count === repos.length,
        "get-repos omits a repo or miscounts",
      );
      outcome = expectToolOk(
        await callTool(workerConn, "get-repos", { name: localName }),
        "get-repos by name",
      );
      repos = asRecords(outcome.data, "repos");
      expect(
        repos.length === 1 && repos[0]?.id === localId && outcome.data.count === 1,
        "get-repos name filter is wrong",
      );
      expect(
        outcome.text.includes(`${localName} (${localUrl}) — guidelines: configured`),
        `get-repos text is ${outcome.text}`,
      );
      outcome = expectToolOk(
        await callTool(workerConn, "get-repos", { name: `e2e-no-such-repo-${ctx.nonce}` }),
        "get-repos with no match",
      );
      expect(
        outcome.message === "No repos found." && outcome.data.count === 0,
        "get-repos with no match did not say so",
      );

      // --- MCP update-repo
      outcome = expectToolOk(
        await callTool(workerConn, "update-repo", {
          id: localId,
          defaultBranch: "release",
          guidelines: guidelines("tool", false),
        }),
        "update-repo by a worker",
      );
      expect(
        asRecord(outcome.data.repo).defaultBranch === "release" &&
          asRecord(asRecord(outcome.data.repo).guidelines).prChecks !== undefined,
        "update-repo response lacks the updated repo",
      );
      expect((await readRepo(ctx, localId)).defaultBranch === "release", "update-repo not stored");
      expectToolError(
        await callTool(workerConn, "update-repo", {
          id: localId,
          guidelines: guidelines("tool", true),
        }),
        "Only lead agents can change allowMerge",
        "update-repo allowMerge by a worker",
      );
      expect(
        asRecord((await readRepo(ctx, localId)).guidelines).allowMerge === false,
        "A refused update-repo allowMerge change was stored",
      );
      outcome = expectToolOk(
        await callTool(leadConn, "update-repo", {
          id: localId,
          guidelines: guidelines("tool", true),
        }),
        "update-repo allowMerge by a lead",
      );
      expect(
        asRecord(asRecord(outcome.data.repo).guidelines).allowMerge === true,
        "Lead update-repo did not turn allowMerge on",
      );
      expectToolError(
        await callTool(leadConn, "update-repo", { id: MISSING_ID, name: "ghost" }),
        "Repo not found",
        "update-repo on a missing repo",
      );
      outcome = expectToolOk(
        await callTool(leadConn, "update-repo", { id: localId, guidelines: null, hooks: null }),
        "update-repo clears guidelines",
      );
      expect(
        asRecord(outcome.data.repo).guidelines === null &&
          asRecord(asRecord(outcome.data.repo).hooks).enabled === false,
        "update-repo null did not clear guidelines and hooks",
      );
      expect(
        (await callTool(leadConn, "update-repo", { id: "not-a-uuid" })).isError,
        "update-repo accepted an id that is not a UUID",
      );

      // --- delete
      for (const id of [leadRepoId, localId, urlId]) {
        response = await ctx.api("DELETE", `/api/repos/${id}`);
        expectStatus(response, [200], `delete repo ${id}`);
        expect(asRecord(response.json).success === true, "Delete did not report success");
        expectStatus(await ctx.api("GET", `/api/repos/${id}`), [404], `read deleted repo ${id}`);
        expect(
          ctx.db.get("SELECT id FROM swarm_repos WHERE id = ?", [id]) === null,
          "Deleted repo is still in swarm_repos",
        );
        expectStatus(await ctx.api("DELETE", `/api/repos/${id}`), [404], "delete a repo twice");
      }
      repoIds.length = 0;
    });
  },
};
