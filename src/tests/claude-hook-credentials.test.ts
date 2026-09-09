import { expect, test } from "bun:test";
import { ClaudeAdapter } from "../providers/claude-adapter";
import type { ProviderSession } from "../providers/types";

const hookTest = process.env.RUN_CLAUDE_HOOK_CREDENTIALS === "1" ? test : test.skip;

for (const transport of ["cli", "sdk"] as const) {
  hookTest(
    `${transport}: project hooks cannot read the OAuth token or its legacy mirror`,
    async () => {
      const executable = process.env.CLAUDE_HOOK_TEST_BINARY || Bun.which("claude");
      expect(executable).toBeTruthy();
      const directory = (
        await Bun.$`mktemp -d /tmp/claude-hook-credentials-XXXXXXXX`.text()
      ).trim();
      let session: ProviderSession | undefined;
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Bun.$`mkdir -p ${directory}/home ${directory}/.claude`.quiet();
        const hookPath = `${directory}/hook.ts`;
        const observationPath = `${directory}/hook.json`;
        const keys = [
          "CLAUDE_CODE_OAUTH_TOKEN",
          "AGENT_SWARM_CLAUDE_OAUTH_TOKEN",
          "ANTHROPIC_API_KEY",
        ];
        await Bun.write(
          hookPath,
          `await Bun.write(${JSON.stringify(observationPath)}, JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, Boolean(process.env[key])]))));`,
        );
        await Bun.write(
          `${directory}/.claude/settings.json`,
          JSON.stringify({
            hooks: {
              SessionStart: [
                { hooks: [{ type: "command", command: `${process.execPath} ${hookPath}` }] },
              ],
            },
          }),
        );
        session = await new ClaudeAdapter(async () => {}).createSession({
          prompt: "Reply OK",
          systemPrompt: "",
          model: "claude-haiku-4-5",
          role: "worker",
          agentId: crypto.randomUUID(),
          taskId: crypto.randomUUID(),
          apiUrl: "",
          apiKey: "",
          cwd: directory,
          logFile: `${directory}/session.jsonl`,
          additionalArgs: ["--max-turns", "0"],
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: `${directory}/home`,
            CLAUDE_CONFIG_DIR: `${directory}/home/.claude`,
            CLAUDE_BINARY: executable!,
            CLAUDE_TRANSPORT: transport,
            CLAUDE_QUEUE_STEERING: "1",
            CLAUDECODE: "",
            CONTEXT_MODE_DISABLED: "true",
            // Synthetic values ensure this probe cannot authenticate or incur model charges.
            CLAUDE_CODE_OAUTH_TOKEN: "synthetic-not-an-oauth-token",
            ANTHROPIC_API_KEY: "synthetic-not-an-api-key",
            AGENT_SWARM_CLAUDE_OAUTH_TOKEN: "synthetic-legacy-mirror",
          },
        });
        abortTimer = setTimeout(() => void session?.abort("hook probe timeout"), 20_000);
        await session.waitForCompletion();
        expect(await Bun.file(observationPath).json()).toEqual({
          CLAUDE_CODE_OAUTH_TOKEN: false,
          AGENT_SWARM_CLAUDE_OAUTH_TOKEN: false,
          // Stock Claude retains API keys for hooks. This is not a general hook sandbox.
          ANTHROPIC_API_KEY: true,
        });
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
        await session?.abort("hook probe cleanup");
        await Bun.$`rm -rf ${directory}`.quiet();
      }
    },
    30_000,
  );
}
