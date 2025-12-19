import { mkdir } from "node:fs/promises";

/** Configuration for a runner role (worker or lead) */
export interface RunnerConfig {
  /** Role name for logging, e.g., "worker" or "lead" */
  role: string;
  /** Default prompt if none provided */
  defaultPrompt: string;
  /** Environment variable name for YOLO mode, e.g., "WORKER_YOLO" */
  yoloEnvVar: string;
  /** Environment variable name for log directory, e.g., "WORKER_LOG_DIR" */
  logDirEnvVar: string;
  /** Metadata type for log files, e.g., "worker_metadata" */
  metadataType: string;
  /** Environment variable name for system prompt text, e.g., "WORKER_SYSTEM_PROMPT" */
  systemPromptEnvVar: string;
  /** Environment variable name for system prompt file path, e.g., "WORKER_SYSTEM_PROMPT_FILE" */
  systemPromptFileEnvVar: string;
}

export interface RunnerOptions {
  prompt?: string;
  yolo?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  additionalArgs?: string[];
}

interface RunClaudeIterationOptions {
  prompt: string;
  logFile: string;
  systemPrompt?: string;
  additionalArgs?: string[];
  role: string;
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

  console.log(`[${role}] Running: claude ... -p "${opts.prompt}"`);

  const logFileHandle = Bun.file(opts.logFile).writer();
  let stderrOutput = "";

  const proc = Bun.spawn(CMD, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  console.log(`[${role}] Process spawned, PID: ${proc.pid}`);
  console.log(`[${role}] Waiting for output streams...`);

  let stdoutChunks = 0;
  let stderrChunks = 0;

  const stdoutPromise = (async () => {
    console.log(`[${role}] stdout stream: ${proc.stdout ? "available" : "not available"}`);
    if (proc.stdout) {
      for await (const chunk of proc.stdout) {
        stdoutChunks++;
        const text = new TextDecoder().decode(chunk);
        logFileHandle.write(text);
        console.log(`[${role}] stdout chunk #${stdoutChunks} (${chunk.length} bytes)`);

        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            const json = JSON.parse(line.trim());
            if (json.type === "assistant" && json.message) {
              const preview = json.message.slice(0, 100);
              console.log(
                `[${role}] Assistant: ${preview}${json.message.length > 100 ? "..." : ""}`,
              );
            } else if (json.type === "tool_use") {
              console.log(`[${role}] Tool: ${json.tool || json.name || "unknown"}`);
            } else if (json.type === "result") {
              const resultPreview = JSON.stringify(json).slice(0, 200);
              console.log(
                `[${role}] Result: ${resultPreview}${JSON.stringify(json).length > 200 ? "..." : ""}`,
              );
            } else if (json.type === "error") {
              console.error(
                `[${role}] Error from Claude: ${json.error || json.message || JSON.stringify(json)}`,
              );
            } else if (json.type === "system") {
              const msg = json.message || json.content || "";
              const preview =
                typeof msg === "string" ? msg.slice(0, 150) : JSON.stringify(msg).slice(0, 150);
              console.log(`[${role}] System: ${preview}${preview.length >= 150 ? "..." : ""}`);
            } else {
              console.log(
                `[${role}] Event type: ${json.type} - ${JSON.stringify(json).slice(0, 100)}`,
              );
            }
          } catch {
            if (line.trim()) {
              console.log(`[${role}] Raw output: ${line.trim()}`);
            }
          }
        }
      }
      console.log(`[${role}] stdout stream ended (total ${stdoutChunks} chunks)`);
    }
  })();

  const stderrPromise = (async () => {
    console.log(`[${role}] stderr stream: ${proc.stderr ? "available" : "not available"}`);
    if (proc.stderr) {
      for await (const chunk of proc.stderr) {
        stderrChunks++;
        const text = new TextDecoder().decode(chunk);
        stderrOutput += text;
        console.error(`[${role}] stderr chunk #${stderrChunks}: ${text.trim()}`);
        logFileHandle.write(
          `${JSON.stringify({ type: "stderr", content: text, timestamp: new Date().toISOString() })}\n`,
        );
      }
      console.log(`[${role}] stderr stream ended (total ${stderrChunks} chunks)`);
    }
  })();

  console.log(`[${role}] Waiting for streams to complete...`);
  await Promise.all([stdoutPromise, stderrPromise]);

  await logFileHandle.end();
  console.log(`[${role}] Waiting for process to exit...`);
  const exitCode = await proc.exited;

  console.log(`[${role}] Claude exited with code ${exitCode}`);
  console.log(`[${role}] Total stdout chunks: ${stdoutChunks}, stderr chunks: ${stderrChunks}`);

  if (exitCode !== 0 && stderrOutput) {
    console.error(`[${role}] Full stderr output:\n${stderrOutput}`);
  }

  if (stdoutChunks === 0 && stderrChunks === 0) {
    console.warn(`[${role}] WARNING: No output received from Claude at all!`);
    console.warn(`[${role}] This might indicate Claude failed to start or auth issues.`);
  }

  return exitCode ?? 1;
}

export async function runAgent(config: RunnerConfig, opts: RunnerOptions) {
  const {
    role,
    defaultPrompt,
    yoloEnvVar,
    logDirEnvVar,
    metadataType,
    systemPromptEnvVar,
    systemPromptFileEnvVar,
  } = config;

  const sessionId = process.env.SESSION_ID || crypto.randomUUID().slice(0, 8);
  const baseLogDir = process.env[logDirEnvVar] || "./logs";
  const logDir = `${baseLogDir}/${sessionId}`;

  await mkdir(logDir, { recursive: true });

  const prompt = opts.prompt || defaultPrompt;
  const isYolo = opts.yolo || process.env[yoloEnvVar] === "true";

  // Resolve system prompt: CLI flag > env var
  let resolvedSystemPrompt: string | undefined;
  const systemPromptText = opts.systemPrompt || process.env[systemPromptEnvVar];
  const systemPromptFilePath = opts.systemPromptFile || process.env[systemPromptFileEnvVar];

  if (systemPromptText) {
    resolvedSystemPrompt = systemPromptText;
    console.log(`[${role}] Using system prompt from ${opts.systemPrompt ? "CLI flag" : "env var"}`);
  } else if (systemPromptFilePath) {
    try {
      const file = Bun.file(systemPromptFilePath);
      if (!(await file.exists())) {
        console.error(`[${role}] ERROR: System prompt file not found: ${systemPromptFilePath}`);
        process.exit(1);
      }
      resolvedSystemPrompt = await file.text();
      console.log(`[${role}] Loaded system prompt from file: ${systemPromptFilePath}`);
      console.log(`[${role}] System prompt length: ${resolvedSystemPrompt.length} characters`);
    } catch (error) {
      console.error(`[${role}] ERROR: Failed to read system prompt file: ${systemPromptFilePath}`);
      console.error(error);
      process.exit(1);
    }
  }

  console.log(`[${role}] Starting ${role}`);
  console.log(`[${role}] Session ID: ${sessionId}`);
  console.log(`[${role}] Log directory: ${logDir}`);
  console.log(`[${role}] YOLO mode: ${isYolo ? "enabled" : "disabled"}`);
  console.log(`[${role}] Prompt: ${prompt}`);
  console.log(`[${role}] System prompt: ${resolvedSystemPrompt ? "provided" : "none"}`);

  let iteration = 0;

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
