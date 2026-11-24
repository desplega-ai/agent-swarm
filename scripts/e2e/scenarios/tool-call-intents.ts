import { randomBytes } from "node:crypto";
import { runCli } from "../cli";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { createAssignedTask } from "./core-helpers";
import { registerWorker } from "./slack-helpers";

/**
 * Intent before effect: the real `hook` (Claude Code) and `codex-hook` commands write an intent
 * row before a side-effecting call (a swarm Slack writer, `gh pr create`) and clear it after.
 * A read-only call writes nothing. A dead API never blocks the call. Only the task's own agent
 * may write its rows. The resume preamble's use of the rows is covered by
 * src/tests/runner-context-preamble.test.ts: the preamble is built worker-side.
 */

async function intents(ctx: ScenarioContext, taskId: string) {
  const response = await ctx.api("GET", `/api/tasks/${taskId}/tool-intents`);
  expectStatus(response, [200], "list tool intents");
  return asRecords(response.json, "intents");
}

export const toolCallIntents: Scenario = {
  name: "tool-call-intents",
  order: 172.5,
  async run(ctx) {
    const token = randomBytes(4).toString("hex");
    const workerId = await registerWorker(ctx, `e2e-tool-intents-${ctx.nonce}`);
    const strangerId = await registerWorker(ctx, `e2e-tool-intents-other-${ctx.nonce}`);
    const taskId = await createAssignedTask(ctx, workerId, `Tool intents ${ctx.nonce}`);
    const dirs: string[] = [];
    let hang: ReturnType<typeof Bun.serve> | undefined;

    async function tmpDir(label: string): Promise<string> {
      const dir = `/tmp/e2e-tool-intents-${token}-${label}-${dirs.length}`;
      dirs.push(dir);
      await Bun.$`mkdir -p ${dir}`.quiet();
      return dir;
    }

    async function claudeHook(apiUrl: string, event: Record<string, unknown>) {
      const cwd = await tmpDir("claude");
      await Bun.write(
        `${cwd}/.mcp.json`,
        JSON.stringify({
          mcpServers: {
            "agent-swarm": {
              type: "http",
              url: `${apiUrl}/mcp`,
              headers: { Authorization: `Bearer ${ctx.apiKey}`, "X-Agent-ID": workerId },
            },
          },
        }),
      );
      return await runCli(["hook"], {
        cwd,
        timeoutMs: 60_000,
        stdin: JSON.stringify({ session_id: `e2e-${token}`, cwd, ...event }),
        // HOOK_WORKSPACE_DIR keeps a worker host's /workspace/.mcp.json from winning over cwd.
        env: {
          CLAUDE_PROJECT_DIR: cwd,
          HOOK_WORKSPACE_DIR: cwd,
          TMPDIR: await tmpDir("tmp"),
          AGENT_SWARM_TASK_ID: taskId,
        },
      });
    }

    try {
      // --- Claude: a Slack reply gets its row before it runs, and loses it after.
      const reply = {
        tool_name: "mcp__agent-swarm__slack-reply",
        tool_input: { message: `Shipped ${token}` },
        tool_use_id: `toolu_reply_${token}`,
      };
      const pre = await claudeHook(ctx.baseUrl, { hook_event_name: "PreToolUse", ...reply });
      expect(pre.exitCode === 0, `PreToolUse exit ${pre.exitCode}: ${pre.stderr}`);
      let rows = await intents(ctx, taskId);
      expect(rows.length === 1, `expected 1 intent after PreToolUse, got ${rows.length}`);
      const row = asRecord(rows[0]);
      expect(row.toolCallId === reply.tool_use_id, `intent id ${String(row.toolCallId)}`);
      expect(row.toolName === reply.tool_name, `intent tool ${String(row.toolName)}`);
      expect(
        String(row.argsSummary).includes(`Shipped ${token}`),
        `intent args ${String(row.argsSummary)}`,
      );

      const post = await claudeHook(ctx.baseUrl, {
        hook_event_name: "PostToolUse",
        ...reply,
        tool_response: "ok",
      });
      expect(post.exitCode === 0, `PostToolUse exit ${post.exitCode}: ${post.stderr}`);
      rows = await intents(ctx, taskId);
      expect(rows.length === 0, `PostToolUse left ${rows.length} intent(s)`);

      // --- Claude: `gh pr create` is recorded; a read-only command is not.
      const ghCall = `toolu_gh_${token}`;
      await claudeHook(ctx.baseUrl, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo skip" },
        tool_use_id: `toolu_ls_${token}`,
      });
      expect((await intents(ctx, taskId)).length === 0, "a read-only Bash call wrote an intent");
      const ghPre = await claudeHook(ctx.baseUrl, {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr create --repo e2e/none --title t --body b" },
        tool_use_id: ghCall,
      });
      expect(ghPre.exitCode === 0, `gh PreToolUse exit ${ghPre.exitCode}: ${ghPre.stderr}`);
      rows = await intents(ctx, taskId);
      expect(
        rows.length === 1 && asRecord(rows[0]).toolCallId === ghCall,
        `gh pr create intents: ${JSON.stringify(rows)}`,
      );

      // --- Codex: same contract through `codex-hook`.
      const codexCall = `call_${token}`;
      const codexEvent = {
        session_id: `e2e-${token}`,
        cwd: "/tmp",
        tool_name: "mcp__agent-swarm__send-task",
        tool_input: { task: "x" },
        tool_use_id: codexCall,
      };
      const codexEnv = async () => ({
        MCP_BASE_URL: ctx.baseUrl,
        AGENT_ID: workerId,
        AGENT_SWARM_API_KEY: ctx.apiKey,
        AGENT_SWARM_TASK_ID: taskId,
        TMPDIR: await tmpDir("codex"),
      });
      const codexPre = await runCli(["codex-hook"], {
        timeoutMs: 60_000,
        stdin: JSON.stringify({ hook_event_name: "PreToolUse", ...codexEvent }),
        env: await codexEnv(),
      });
      expect(codexPre.exitCode === 0, `codex PreToolUse exit ${codexPre.exitCode}`);
      rows = await intents(ctx, taskId);
      expect(
        rows.some((r) => asRecord(r).toolCallId === codexCall),
        `codex intent missing: ${JSON.stringify(rows)}`,
      );
      const codexPost = await runCli(["codex-hook"], {
        timeoutMs: 60_000,
        stdin: JSON.stringify({ hook_event_name: "PostToolUse", ...codexEvent }),
        env: await codexEnv(),
      });
      expect(codexPost.exitCode === 0, `codex PostToolUse exit ${codexPost.exitCode}`);
      rows = await intents(ctx, taskId);
      expect(
        !rows.some((r) => asRecord(r).toolCallId === codexCall),
        "codex PostToolUse left its intent",
      );

      // --- Fail open: an API that never answers does not block the call.
      hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
      const started = Date.now();
      const dead = await claudeHook(`http://127.0.0.1:${hang.port}`, {
        hook_event_name: "PreToolUse",
        ...reply,
        tool_use_id: `toolu_dead_${token}`,
      });
      expect(dead.exitCode === 0, `PreToolUse against a hung API exit ${dead.exitCode}`);
      expect(Date.now() - started < 45_000, "PreToolUse against a hung API took too long");

      // --- Only the task's own agent writes its rows; an unknown task is 404.
      const foreign = await ctx.api("POST", `/api/tasks/${taskId}/tool-intents`, {
        agentId: strangerId,
        body: { toolCallId: `toolu_foreign_${token}`, toolName: "slack-post" },
      });
      expectStatus(foreign, [403], "another agent records an intent");
      const foreignClear = await ctx.api(
        "DELETE",
        `/api/tasks/${taskId}/tool-intents/${encodeURIComponent(ghCall)}`,
        { agentId: strangerId },
      );
      expectStatus(foreignClear, [403], "another agent clears an intent");
      const missing = await ctx.api("POST", `/api/tasks/${crypto.randomUUID()}/tool-intents`, {
        agentId: workerId,
        body: { toolCallId: "x", toolName: "slack-post" },
      });
      expectStatus(missing, [404], "intent for an unknown task");

      // --- A retried write keeps one row; a clear reports what it removed.
      const again = await ctx.api("POST", `/api/tasks/${taskId}/tool-intents`, {
        agentId: workerId,
        body: { toolCallId: ghCall, toolName: "Bash", argsSummary: "retry" },
      });
      expectStatus(again, [201], "retried intent write");
      expect(
        asRecord(asRecord(again.json).intent).argsSummary !== "retry",
        "a retried write replaced the first row",
      );
      const cleared = await ctx.api(
        "DELETE",
        `/api/tasks/${taskId}/tool-intents/${encodeURIComponent(ghCall)}`,
        { agentId: workerId },
      );
      expectStatus(cleared, [200], "clear an intent");
      expect(asRecord(cleared.json).deleted === true, "clear did not report a deletion");
      expect((await intents(ctx, taskId)).length === 0, "intents left after the last clear");
    } finally {
      hang?.stop(true);
      for (const dir of dirs) await Bun.$`rm -rf ${dir}`.quiet().nothrow();
    }
  },
};
