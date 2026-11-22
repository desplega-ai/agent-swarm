import { createReadStream } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { scrubSecrets } from "../utils/secret-scrubber";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function claudeProjectsDir(env: NodeJS.ProcessEnv): string {
  return join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "projects");
}

interface ClaudeRequestSettings {
  observedModel: string;
  observedReasoningEffort?: string | number;
}

/** Read only the model and effort of the last recorded main-thread Messages request. */
export async function readClaudeRequestSettings(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeRequestSettings | undefined> {
  // Claude names the main JSONL file by UUID. Project directory names can be
  // overridden or hashed, and subagent transcripts live another level down.
  if (!SESSION_ID.test(sessionId)) return;
  const projects = claudeProjectsDir(env);
  try {
    for await (const path of new Bun.Glob(`*/${sessionId}.jsonl`).scan({
      cwd: projects,
      absolute: true,
    })) {
      let settings: ClaudeRequestSettings | undefined;
      const stream = createReadStream(path);
      try {
        for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
          if (!line.includes('"api-request"')) continue;
          try {
            const entry = JSON.parse(line);
            const source = entry?.querySource;
            if (
              entry?.type !== "api-request" ||
              entry.sessionId !== sessionId ||
              entry.agentId ||
              typeof source !== "string" ||
              !(source === "sdk" || source.startsWith("repl_main_thread")) ||
              typeof entry.params?.model !== "string"
            )
              continue;
            const effort = entry.params.output_config?.effort;
            settings = { observedModel: scrubSecrets(entry.params.model) };
            if (typeof effort === "string") settings.observedReasoningEffort = scrubSecrets(effort);
            if (typeof effort === "number") settings.observedReasoningEffort = effort;
          } catch {
            // A partial JSONL record does not invalidate an earlier observation.
          }
        }
      } finally {
        stream.destroy();
      }
      return settings;
    }
  } catch {
    // Older CLIs and sessions with persistence disabled have no replay file.
  }
}

/**
 * Delete a finished session's transcript and subagent transcripts. Swarm
 * sessions are never resumed, so the file only has to live until the request
 * settings are read.
 */
export async function removeClaudeSessionTranscript(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!SESSION_ID.test(sessionId)) return;
  const projects = claudeProjectsDir(env);
  for (const dir of await readdir(projects).catch(() => [])) {
    await rm(join(projects, dir, `${sessionId}.jsonl`), { force: true }).catch(() => {});
    await rm(join(projects, dir, sessionId), { recursive: true, force: true }).catch(() => {});
  }
}
