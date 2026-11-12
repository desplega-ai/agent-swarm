import { randomBytes } from "node:crypto";
import { type CliResult, runCli } from "../cli";
import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerWorker } from "./slack-helpers";

/**
 * Native tool interception: the real `hook` (Claude Code) and `codex-hook` commands, fed the
 * events their harness sends, against a probe extension with `toolSources: ["native"]`.
 * Sentinel blocked, sentinel rewritten, control passes, API down passes, no extension means no
 * round trip. Pi and opencode run in-process inside their harness and are not started here.
 */

const PROBE_HOOKS = `
import { block, modify, type SwarmExtension } from "swarm-extension";

const extension: SwarmExtension = (api) => {
  api.on("pre.tool.call", async (event) => {
    const args = (event.args ?? {}) as { command?: unknown; path?: unknown };
    const command = String(args.command ?? "");
    const path = String(args.path ?? "");
    if (command.includes("E2E_BLOCK_") || path.includes("E2E_BLOCK_")) {
      return block("native-probe: sentinel blocked");
    }
    if (command.includes("E2E_REWRITE_")) {
      return modify({ args: { ...args, command: command.replace("E2E_REWRITE_", "REWRITTEN_") } });
    }
    if (path.includes("E2E_REWRITE_")) {
      return modify({ args: { ...args, path: path.replace("E2E_REWRITE_", "REWRITTEN_") } });
    }
  });
  api.on("post.tool.call", async () => {});
};

export default extension;
`;

const MANIFEST = {
  name: "e2e-native-probe",
  description: "Blocks and rewrites sentinel native tool calls",
  version: "1.0.0",
  runtime: "api",
  toolSources: ["native"],
  assets: { hooks: "hooks.ts" },
};

async function nativeRuns(ctx: ScenarioContext, extensionId: string) {
  const response = await ctx.api("GET", `/api/extensions/${extensionId}/runs?limit=200`);
  expectStatus(response, [200], "read native probe runs");
  return asRecords(response.json, "runs");
}

/** The one JSON object a hook printed, or a failure that shows what it printed instead. */
function hookOutput(result: CliResult, label: string): Record<string, unknown> {
  try {
    return asRecord(asRecord(JSON.parse(result.stdout)).hookSpecificOutput);
  } catch {
    throw new Error(
      `${label}: no hook JSON on stdout (exit ${result.exitCode})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

function count(runs: Record<string, unknown>[], event: string, action: string): number {
  return runs.filter((run) => run.event === event && run.action === action).length;
}

/** A listener that counts requests and answers like the API would, or never answers. */
function countingServer(answer: "none" | "hang") {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      if (answer === "hang") return await new Promise<Response>(() => {});
      return Response.json({ native: false });
    },
  });
  return { seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export const nativeToolHooks: Scenario = {
  name: "native-tool-hooks",
  order: 172,
  async run(ctx) {
    const token = randomBytes(4).toString("hex");
    const workerId = await registerWorker(ctx, `e2e-native-hooks-${ctx.nonce}`);
    const dirs: string[] = [];
    let extensionId: string | undefined;
    let configId: string | undefined;
    const servers: Array<() => void> = [];

    /** A project dir whose `.mcp.json` points the Claude hook at `apiUrl`. */
    async function projectDir(apiUrl: string): Promise<string> {
      const dir = `/tmp/e2e-native-hooks-${token}-${dirs.length}`;
      dirs.push(dir);
      await Bun.$`mkdir -p ${dir}`.quiet();
      await Bun.write(
        `${dir}/.mcp.json`,
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
      return dir;
    }

    /** Fresh TMPDIR per call: the 30 s status cache lives there. */
    async function freshTmp(): Promise<string> {
      const dir = `/tmp/e2e-native-hooks-tmp-${token}-${dirs.length}`;
      dirs.push(dir);
      await Bun.$`mkdir -p ${dir}`.quiet();
      return dir;
    }

    async function claudeHook(
      apiUrl: string,
      event: Record<string, unknown>,
      tmp?: string,
      timeoutMs = 60_000,
    ) {
      const cwd = await projectDir(apiUrl);
      return await runCli(["hook"], {
        cwd,
        timeoutMs,
        stdin: JSON.stringify({
          session_id: `e2e-${token}`,
          cwd,
          permission_mode: "bypassPermissions",
          ...event,
        }),
        env: { CLAUDE_PROJECT_DIR: cwd, TMPDIR: tmp ?? (await freshTmp()) },
      });
    }

    async function codexHook(
      apiUrl: string,
      event: Record<string, unknown>,
      tmp?: string,
      timeoutMs = 60_000,
    ) {
      return await runCli(["codex-hook"], {
        timeoutMs,
        stdin: JSON.stringify({ session_id: `e2e-${token}`, cwd: "/tmp", ...event }),
        env: {
          MCP_BASE_URL: apiUrl,
          AGENT_ID: workerId,
          AGENT_SWARM_API_KEY: ctx.apiKey,
          TMPDIR: tmp ?? (await freshTmp()),
        },
      });
    }

    const bash = (command: string) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: `toolu_${token}`,
    });

    try {
      // The probe needs an inline bundle, which stays off until the operator opts in.
      const flag = await ctx.api("PUT", "/api/config", {
        body: {
          scope: "global",
          key: "EXTENSION_ALLOW_INLINE_INSTALL",
          value: "true",
          isSecret: false,
        },
      });
      expectStatus(flag, [200, 201], "allow inline extension install");
      configId = String(asRecord(flag.json).id ?? "");
      // The config write reloads the API's env on a short debounce: retry the install until it lands.
      let installed = await ctx.api("POST", "/api/extensions/install", {
        body: { manifest: MANIFEST, files: { "hooks.ts": PROBE_HOOKS } },
      });
      const deadline = Date.now() + 15_000;
      while (installed.status === 400 && Date.now() < deadline) {
        await Bun.sleep(500);
        installed = await ctx.api("POST", "/api/extensions/install", {
          body: { manifest: MANIFEST, files: { "hooks.ts": PROBE_HOOKS } },
        });
      }
      expectStatus(installed, [200], "install native probe");
      extensionId = String(asRecord(asRecord(installed.json).extension).id);

      // --- No enabled extension takes native calls: status is false and the shim sends nothing.
      let status = await ctx.api("GET", "/api/tool-hooks/status");
      expectStatus(status, [200], "tool hook status, probe disabled");
      expect(asRecord(status.json).native === false, "status said native before any extension");
      const idle = countingServer("none");
      servers.push(idle.stop);
      const tmp = await freshTmp();
      const idleFirst = await codexHook(idle.url, bash(`echo E2E_BLOCK_${token}`), tmp);
      expect(idleFirst.exitCode === 0, `codex-hook exit ${idleFirst.exitCode} with no extension`);
      const idleSecond = await codexHook(idle.url, bash(`echo E2E_BLOCK_${token}`), tmp);
      expect(idleSecond.exitCode === 0, "codex-hook second call failed with no extension");
      expect(
        idle.seen.join(",") === "GET /api/tool-hooks/status",
        `Expected one status read and no hook POST (cached for the second call), saw ${idle.seen.join(", ")}`,
      );

      const enabled = await ctx.api("POST", `/api/extensions/${extensionId}/enable`);
      expectStatus(enabled, [200], "enable native probe");
      status = await ctx.api("GET", "/api/tool-hooks/status");
      expect(asRecord(status.json).native === true, "status did not turn true once enabled");

      // --- Claude Code: the real `hook` command.
      const claudeBlock = await claudeHook(ctx.baseUrl, bash(`echo E2E_BLOCK_${token}`));
      expect(
        claudeBlock.exitCode === 2 && claudeBlock.stderr.includes("native-probe: sentinel blocked"),
        `claude hook did not block the sentinel: exit ${claudeBlock.exitCode}\n${claudeBlock.stderr}`,
      );
      const claudeRewrite = await claudeHook(ctx.baseUrl, bash(`echo E2E_REWRITE_${token}`));
      expect(claudeRewrite.exitCode === 0, `claude rewrite exit ${claudeRewrite.exitCode}`);
      const rewritten = hookOutput(claudeRewrite, "claude rewrite");
      expect(
        rewritten.permissionDecision === "allow" &&
          asRecord(rewritten.updatedInput).command === `echo REWRITTEN_${token}`,
        `claude rewrite output was ${claudeRewrite.stdout}`,
      );
      const claudeControl = await claudeHook(ctx.baseUrl, bash(`echo E2E_OK_${token}`));
      expect(
        claudeControl.exitCode === 0 && claudeControl.stdout.trim() === "",
        `claude control did not pass untouched: exit ${claudeControl.exitCode}\n${claudeControl.stdout}${claudeControl.stderr}`,
      );
      // Claude names the path `file_path`; extensions see `path`, and a rewrite maps back.
      const claudeWrite = await claudeHook(ctx.baseUrl, {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: `/tmp/E2E_REWRITE_${token}.txt`, content: "x" },
        tool_use_id: `toolu_w_${token}`,
      });
      const writeOut = hookOutput(claudeWrite, "claude Write rewrite");
      expect(
        asRecord(writeOut.updatedInput).file_path === `/tmp/REWRITTEN_${token}.txt` &&
          asRecord(writeOut.updatedInput).content === "x" &&
          !("path" in asRecord(writeOut.updatedInput)),
        `claude Write rewrite output was ${claudeWrite.stdout}`,
      );
      // A swarm MCP tool is not native: it never reaches the native route.
      const claudeMcp = await claudeHook(ctx.baseUrl, {
        hook_event_name: "PreToolUse",
        tool_name: "mcp__agent-swarm__store-progress",
        tool_input: { command: `E2E_BLOCK_${token}` },
        tool_use_id: `toolu_m_${token}`,
      });
      expect(claudeMcp.exitCode === 0, "claude hook blocked an MCP tool through the native route");
      const claudePost = await claudeHook(ctx.baseUrl, {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: `echo E2E_OK_${token}` },
        tool_response: { stdout: "ok" },
        tool_use_id: `toolu_${token}`,
      });
      expect(claudePost.exitCode === 0, `claude post hook exit ${claudePost.exitCode}`);

      // --- Codex: the real `codex-hook` command.
      const codexBlock = await codexHook(ctx.baseUrl, bash(`echo E2E_BLOCK_${token}`));
      expect(
        codexBlock.exitCode === 2 && codexBlock.stderr.includes("native-probe: sentinel blocked"),
        `codex-hook did not block the sentinel: exit ${codexBlock.exitCode}\n${codexBlock.stderr}`,
      );
      const codexRewrite = await codexHook(ctx.baseUrl, bash(`echo E2E_REWRITE_${token}`));
      const codexOut = hookOutput(codexRewrite, "codex rewrite");
      expect(
        codexRewrite.exitCode === 0 &&
          asRecord(codexOut.updatedInput).command === `echo REWRITTEN_${token}`,
        `codex rewrite output was ${codexRewrite.stdout}`,
      );
      const codexControl = await codexHook(ctx.baseUrl, bash(`echo E2E_OK_${token}`));
      expect(
        codexControl.exitCode === 0 && codexControl.stdout.trim() === "",
        `codex control did not pass untouched: exit ${codexControl.exitCode}\n${codexControl.stdout}${codexControl.stderr}`,
      );
      const codexPost = await codexHook(ctx.baseUrl, {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: `echo E2E_OK_${token}` },
        tool_response: "ok",
        tool_use_id: `toolu_${token}`,
      });
      expect(codexPost.exitCode === 0, `codex post hook exit ${codexPost.exitCode}`);

      // --- The run log holds what both shims sent: 3 blocks/rewrites each way, plus posts.
      const seen = await pollUntil(
        async () =>
          count(await nativeRuns(ctx, extensionId as string), "post.tool.call", "continue") >= 2,
        15_000,
        250,
      );
      expect(seen, "Both post reports did not reach the extension");
      const runs = await nativeRuns(ctx, extensionId);
      expect(
        count(runs, "pre.tool.call", "block") === 2 && count(runs, "pre.tool.call", "modify") === 3,
        `Expected 2 blocks and 3 rewrites in the run log, got ${JSON.stringify(
          runs.map((run) => `${run.event}:${run.action}`),
        )}`,
      );

      // --- Fail open: API down (connection refused) and API hanging (2 s timeout).
      const down = "http://127.0.0.1:1";
      const claudeDown = await claudeHook(down, bash(`echo E2E_BLOCK_${token}`));
      expect(
        claudeDown.exitCode === 0 && !claudeDown.stdout.includes("deny"),
        `claude hook did not fail open with the API down: exit ${claudeDown.exitCode}`,
      );
      const codexDown = await codexHook(down, bash(`echo E2E_BLOCK_${token}`));
      expect(
        codexDown.exitCode === 0 && codexDown.stdout.trim() === "",
        `codex-hook did not fail open with the API down: exit ${codexDown.exitCode}`,
      );
      const hanging = countingServer("hang");
      servers.push(hanging.stop);
      const started = Date.now();
      const codexHang = await codexHook(hanging.url, bash(`echo E2E_BLOCK_${token}`));
      expect(
        codexHang.exitCode === 0 && Date.now() - started < 10_000,
        `codex-hook did not fail open on a hanging API: exit ${codexHang.exitCode} in ${Date.now() - started} ms`,
      );
    } finally {
      for (const stop of servers) stop();
      if (extensionId) {
        await ctx.api("POST", `/api/extensions/${extensionId}/disable`);
        await ctx.api("DELETE", `/api/extensions/${extensionId}`);
      }
      if (configId) await ctx.api("DELETE", `/api/config/${configId}`);
      for (const dir of dirs) await Bun.$`rm -rf ${dir}`.quiet().nothrow();
    }
  },
};
