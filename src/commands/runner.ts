import { mkdir } from "node:fs/promises";
import { getBasePrompt } from "../prompts/base-prompt.ts";
import { prettyPrintLine, prettyPrintStderr } from "../utils/pretty-print.ts";

/** Save PM2 process list for persistence across container restarts */
async function savePm2State(role: string): Promise<void> {
  try {
    console.log(`[${role}] Saving PM2 process list...`);
    await Bun.$`pm2 save`.quiet();
    console.log(`[${role}] PM2 state saved`);
  } catch {
    // PM2 not available or no processes - silently ignore
  }
}

/** Setup signal handlers for graceful shutdown */
function setupShutdownHandlers(role: string): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[${role}] Received ${signal}, shutting down...`);
    await savePm2State(role);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Configuration for a runner role (worker or lead) */
export interface RunnerConfig {
  /** Role name for logging, e.g., "worker" or "lead" */
  role: string;
  /** Default prompt if none provided */
  defaultPrompt: string;
  /** Metadata type for log files, e.g., "worker_metadata" */
  metadataType: string;
  /** Optional capabilities of the agent */
  capabilities?: string[];
}

export interface RunnerOptions {
  prompt?: string;
  yolo?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  logsDir?: string;
  additionalArgs?: string[];
  aiLoop?: boolean; // Use AI-based loop (old behavior)
}

interface RunClaudeIterationOptions {
  prompt: string;
  logFile: string;
  systemPrompt?: string;
  additionalArgs?: string[];
  role: string;
  // New fields for log streaming
  apiUrl?: string;
  apiKey?: string;
  agentId?: string;
  sessionId?: string;
  iteration?: number;
  taskId?: string;
}

/** Buffer for session logs */
interface LogBuffer {
  lines: string[];
  lastFlush: number;
}

/** Configuration for log streaming */
const LOG_BUFFER_SIZE = 50; // Flush after this many lines
const LOG_FLUSH_INTERVAL_MS = 5000; // Flush every 5 seconds

/** Push buffered logs to the API */
async function flushLogBuffer(
  buffer: LogBuffer,
  opts: {
    apiUrl: string;
    apiKey: string;
    agentId: string;
    sessionId: string;
    iteration: number;
    taskId?: string;
    cli?: string;
  },
): Promise<void> {
  if (buffer.lines.length === 0) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  try {
    const response = await fetch(`${opts.apiUrl}/api/session-logs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: opts.sessionId,
        iteration: opts.iteration,
        taskId: opts.taskId,
        cli: opts.cli || "claude",
        lines: buffer.lines,
      }),
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to push logs: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[runner] Error pushing logs: ${error}`);
  }

  // Clear buffer after flush
  buffer.lines = [];
  buffer.lastFlush = Date.now();
}

/** Trigger types returned by the poll API */
interface Trigger {
  type: "task_assigned" | "task_offered" | "unread_mentions" | "pool_tasks_available";
  taskId?: string;
  task?: unknown;
  mentionsCount?: number;
  count?: number;
}

/** Options for polling */
interface PollOptions {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  pollInterval: number;
  pollTimeout: number;
}

/** Register agent via HTTP API */
async function registerAgent(opts: {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  name: string;
  isLead: boolean;
  capabilities?: string[];
}): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  const response = await fetch(`${opts.apiUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: opts.name,
      isLead: opts.isLead,
      capabilities: opts.capabilities,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register agent: ${response.status} ${error}`);
  }
}

/** Poll for triggers via HTTP API */
async function pollForTrigger(opts: PollOptions): Promise<Trigger | null> {
  const startTime = Date.now();
  const headers: Record<string, string> = {
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  while (Date.now() - startTime < opts.pollTimeout) {
    try {
      const response = await fetch(`${opts.apiUrl}/api/poll`, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        console.warn(`[runner] Poll request failed: ${response.status}`);
        await Bun.sleep(opts.pollInterval);
        continue;
      }

      const data = (await response.json()) as { trigger: Trigger | null };
      if (data.trigger) {
        return data.trigger;
      }
    } catch (error) {
      console.warn(`[runner] Poll request error: ${error}`);
    }

    await Bun.sleep(opts.pollInterval);
  }

  return null; // Timeout reached, no trigger found
}

/** Build prompt based on trigger type */
function buildPromptForTrigger(trigger: Trigger, defaultPrompt: string): string {
  switch (trigger.type) {
    case "task_assigned":
      // Use the work-on-task command with task ID
      return `/work-on-task ${trigger.taskId}`;

    case "task_offered":
      // Use the review-offered-task command to accept/reject
      return `/review-offered-task ${trigger.taskId}`;

    case "unread_mentions":
      // Check messages
      return "/swarm-chat";

    case "pool_tasks_available":
      // Let lead review and assign tasks
      return defaultPrompt;

    default:
      return defaultPrompt;
  }
}

async function runClaudeIteration(opts: RunClaudeIterationOptions): Promise<number> {
  const { role } = opts;
  const CMD = [
    "claude",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "-p",
    opts.prompt,
  ];

  if (opts.additionalArgs && opts.additionalArgs.length > 0) {
    CMD.push(...opts.additionalArgs);
  }

  if (opts.systemPrompt) {
    CMD.push("--append-system-prompt", opts.systemPrompt);
  }

  console.log(`\x1b[2m[${role}]\x1b[0m \x1b[36m▸\x1b[0m Starting Claude (PID will follow)`);

  const logFileHandle = Bun.file(opts.logFile).writer();
  let stderrOutput = "";

  const proc = Bun.spawn(CMD, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdoutChunks = 0;
  let stderrChunks = 0;

  const stdoutPromise = (async () => {
    if (proc.stdout) {
      // Initialize log buffer for API streaming
      const logBuffer: LogBuffer = { lines: [], lastFlush: Date.now() };
      const shouldStream = opts.apiUrl && opts.sessionId && opts.iteration;

      for await (const chunk of proc.stdout) {
        stdoutChunks++;
        const text = new TextDecoder().decode(chunk);
        logFileHandle.write(text);

        const lines = text.split("\n");
        for (const line of lines) {
          prettyPrintLine(line, role);

          // Buffer non-empty lines for API streaming
          if (shouldStream && line.trim()) {
            logBuffer.lines.push(line.trim());

            // Check if we should flush (buffer full or time elapsed)
            const shouldFlush =
              logBuffer.lines.length >= LOG_BUFFER_SIZE ||
              Date.now() - logBuffer.lastFlush >= LOG_FLUSH_INTERVAL_MS;

            if (shouldFlush) {
              await flushLogBuffer(logBuffer, {
                apiUrl: opts.apiUrl!,
                apiKey: opts.apiKey || "",
                agentId: opts.agentId || "",
                sessionId: opts.sessionId!,
                iteration: opts.iteration!,
                taskId: opts.taskId,
                cli: "claude",
              });
            }
          }
        }
      }

      // Final flush for remaining buffered logs
      if (shouldStream && logBuffer.lines.length > 0) {
        await flushLogBuffer(logBuffer, {
          apiUrl: opts.apiUrl!,
          apiKey: opts.apiKey || "",
          agentId: opts.agentId || "",
          sessionId: opts.sessionId!,
          iteration: opts.iteration!,
          taskId: opts.taskId,
          cli: "claude",
        });
      }
    }
  })();

  const stderrPromise = (async () => {
    if (proc.stderr) {
      for await (const chunk of proc.stderr) {
        stderrChunks++;
        const text = new TextDecoder().decode(chunk);
        stderrOutput += text;
        prettyPrintStderr(text, role);
        logFileHandle.write(
          `${JSON.stringify({ type: "stderr", content: text, timestamp: new Date().toISOString() })}\n`,
        );
      }
    }
  })();

  await Promise.all([stdoutPromise, stderrPromise]);
  await logFileHandle.end();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && stderrOutput) {
    console.error(`\x1b[31m[${role}] Full stderr:\x1b[0m\n${stderrOutput}`);
  }

  if (stdoutChunks === 0 && stderrChunks === 0) {
    console.warn(`\x1b[33m[${role}] WARNING: No output from Claude - check auth/startup\x1b[0m`);
  }

  return exitCode ?? 1;
}

export async function runAgent(config: RunnerConfig, opts: RunnerOptions) {
  const { role, defaultPrompt, metadataType } = config;

  // Setup graceful shutdown handlers (saves PM2 state on Ctrl+C)
  setupShutdownHandlers(role);

  const sessionId = process.env.SESSION_ID || crypto.randomUUID().slice(0, 8);
  const baseLogDir = opts.logsDir || process.env.LOG_DIR || "/logs";
  const logDir = `${baseLogDir}/${sessionId}`;

  await mkdir(logDir, { recursive: true });

  const prompt = opts.prompt || defaultPrompt;
  const isYolo = opts.yolo || process.env.YOLO === "true";

  // Get agent identity and swarm URL for base prompt
  const agentId = process.env.AGENT_ID || "unknown";

  const apiUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
  const swarmUrl = process.env.SWARM_URL || "localhost";

  const capabilities = config.capabilities;

  // Generate base prompt that's always included
  const basePrompt = getBasePrompt({ role, agentId, swarmUrl, capabilities });

  // Resolve additional system prompt: CLI flag > env var
  let additionalSystemPrompt: string | undefined;
  const systemPromptText = opts.systemPrompt || process.env.SYSTEM_PROMPT;
  const systemPromptFilePath = opts.systemPromptFile || process.env.SYSTEM_PROMPT_FILE;

  if (systemPromptText) {
    additionalSystemPrompt = systemPromptText;
    console.log(
      `[${role}] Using additional system prompt from ${opts.systemPrompt ? "CLI flag" : "env var"}`,
    );
  } else if (systemPromptFilePath) {
    try {
      const file = Bun.file(systemPromptFilePath);
      if (!(await file.exists())) {
        console.error(`[${role}] ERROR: System prompt file not found: ${systemPromptFilePath}`);
        process.exit(1);
      }
      additionalSystemPrompt = await file.text();
      console.log(`[${role}] Loaded additional system prompt from file: ${systemPromptFilePath}`);
      console.log(
        `[${role}] Additional system prompt length: ${additionalSystemPrompt.length} characters`,
      );
    } catch (error) {
      console.error(`[${role}] ERROR: Failed to read system prompt file: ${systemPromptFilePath}`);
      console.error(error);
      process.exit(1);
    }
  }

  // Combine base prompt with any additional system prompt
  const resolvedSystemPrompt = additionalSystemPrompt
    ? `${basePrompt}\n\n${additionalSystemPrompt}`
    : basePrompt;

  console.log(`[${role}] Starting ${role}`);
  console.log(`[${role}] Agent ID: ${agentId}`);
  console.log(`[${role}] Session ID: ${sessionId}`);
  console.log(`[${role}] Log directory: ${logDir}`);
  console.log(`[${role}] YOLO mode: ${isYolo ? "enabled" : "disabled"}`);
  console.log(`[${role}] Prompt: ${prompt}`);
  console.log(`[${role}] API URL: ${apiUrl}`);
  console.log(`[${role}] Swarm URL: ${apiUrl}`);
  console.log(`[${role}] Base prompt: included (${basePrompt.length} chars)`);
  console.log(
    `[${role}] Additional system prompt: ${additionalSystemPrompt ? "provided" : "none"}`,
  );
  console.log(`[${role}] Total system prompt length: ${resolvedSystemPrompt.length} chars`);

  const isAiLoop = opts.aiLoop || process.env.AI_LOOP === "true";
  const apiKey = process.env.API_KEY || "";

  // Constants for polling
  const POLL_INTERVAL_MS = 2000; // 2 seconds between polls
  const POLL_TIMEOUT_MS = 60000; // 1 minute timeout before retrying

  let iteration = 0;

  if (!isAiLoop) {
    // NEW: Runner-level polling mode
    console.log(`[${role}] Mode: runner-level polling (use --ai-loop for AI-based polling)`);

    // Register agent before starting
    const agentName = process.env.AGENT_NAME || `${role}-${agentId.slice(0, 8)}`;
    try {
      await registerAgent({
        apiUrl,
        apiKey,
        agentId,
        name: agentName,
        isLead: role === "lead",
        capabilities: config.capabilities,
      });
      console.log(`[${role}] Registered as "${agentName}" (ID: ${agentId})`);
    } catch (error) {
      console.error(`[${role}] Failed to register: ${error}`);
      process.exit(1);
    }

    while (true) {
      console.log(`\n[${role}] Polling for triggers...`);

      const trigger = await pollForTrigger({
        apiUrl,
        apiKey,
        agentId,
        pollInterval: POLL_INTERVAL_MS,
        pollTimeout: POLL_TIMEOUT_MS,
      });

      if (!trigger) {
        console.log(`[${role}] No trigger found, polling again...`);
        continue;
      }

      console.log(`[${role}] Trigger received: ${trigger.type}`);

      // Build prompt based on trigger
      const triggerPrompt = buildPromptForTrigger(trigger, prompt);

      iteration++;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFile = `${logDir}/${timestamp}.jsonl`;

      console.log(`\n[${role}] === Iteration ${iteration} ===`);
      console.log(`[${role}] Logging to: ${logFile}`);
      console.log(`[${role}] Prompt: ${triggerPrompt}`);

      const metadata = {
        type: metadataType,
        sessionId,
        iteration,
        timestamp: new Date().toISOString(),
        prompt: triggerPrompt,
        trigger: trigger.type,
        yolo: isYolo,
      };
      await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

      const exitCode = await runClaudeIteration({
        prompt: triggerPrompt,
        logFile,
        systemPrompt: resolvedSystemPrompt,
        additionalArgs: opts.additionalArgs,
        role,
        // Add streaming options
        apiUrl,
        apiKey,
        agentId,
        sessionId,
        iteration,
        taskId: trigger.taskId,
      });

      if (exitCode !== 0) {
        const errorLog = {
          timestamp: new Date().toISOString(),
          iteration,
          exitCode,
          trigger: trigger.type,
          error: true,
        };

        const errorsFile = `${logDir}/errors.jsonl`;
        const errorsFileRef = Bun.file(errorsFile);
        const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
        await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

        if (!isYolo) {
          console.error(`[${role}] Claude exited with code ${exitCode}. Stopping.`);
          console.error(`[${role}] Error logged to: ${errorsFile}`);
          process.exit(exitCode);
        }

        console.warn(`[${role}] Claude exited with code ${exitCode}. YOLO mode - continuing...`);
      }

      console.log(`[${role}] Iteration ${iteration} complete. Polling for next trigger...`);
    }
  } else {
    // Original AI-loop mode (existing behavior)
    console.log(`[${role}] Mode: AI-based polling (legacy)`);

    while (true) {
      iteration++;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFile = `${logDir}/${timestamp}.jsonl`;

      console.log(`\n[${role}] === Iteration ${iteration} ===`);
      console.log(`[${role}] Logging to: ${logFile}`);

      const metadata = {
        type: metadataType,
        sessionId,
        iteration,
        timestamp: new Date().toISOString(),
        prompt,
        yolo: isYolo,
      };
      await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

      const exitCode = await runClaudeIteration({
        prompt,
        logFile,
        systemPrompt: resolvedSystemPrompt,
        additionalArgs: opts.additionalArgs,
        role,
      });

      if (exitCode !== 0) {
        const errorLog = {
          timestamp: new Date().toISOString(),
          iteration,
          exitCode,
          error: true,
        };

        const errorsFile = `${logDir}/errors.jsonl`;
        const errorsFileRef = Bun.file(errorsFile);
        const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
        await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

        if (!isYolo) {
          console.error(`[${role}] Claude exited with code ${exitCode}. Stopping.`);
          console.error(`[${role}] Error logged to: ${errorsFile}`);
          process.exit(exitCode);
        }

        console.warn(`[${role}] Claude exited with code ${exitCode}. YOLO mode - continuing...`);
      }

      console.log(`[${role}] Iteration ${iteration} complete. Starting next iteration...`);
    }
  }
}
