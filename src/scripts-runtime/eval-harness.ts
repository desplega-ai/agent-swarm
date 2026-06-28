import { buildCtx } from "./ctx";
import { patchFetchWithEgressSubstitution } from "./egress-secrets";
import type { SwarmConfigPayload } from "./executors/types";
import { SwarmConfig } from "./swarm-config";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

type StackFrame = { file: string; line: number; column: number; raw: string };
type StructuredError = {
  name: string;
  message: string;
  stack: string;
  userFrames: StackFrame[];
  userScriptLine?: number;
  userScriptColumn?: number;
};

function buildStructuredError(err: unknown, userModulePath: string): StructuredError {
  const errObj = err instanceof Error ? err : new Error(String(err));
  const name = errObj.name || "Error";
  const message = errObj.message || String(err);
  const stack = errObj.stack || `${name}: ${message}`;

  const userScriptName = userModulePath.split("/").pop() ?? "user-script.ts";
  const userFrames: StackFrame[] = [];

  // Stack frames look like:
  //   "    at functionName (/tmp/.../user-script.ts:LINE:COL)"
  //   "    at /tmp/.../user-script.ts:LINE:COL"
  // We surface only frames inside the user's script. The userModulePath is the
  // exact tmpdir copy created above, so match either that absolute path or the
  // bare basename "user-script.ts".
  const frameRe = /\s+at\s+(?:[^\s]+\s+\()?([^\s()]+):(\d+):(\d+)\)?/g;
  for (const match of stack.matchAll(frameRe)) {
    const [, file, line, col] = match;
    if (!file || !line || !col) continue;
    if (file === userModulePath || file.endsWith(`/${userScriptName}`)) {
      userFrames.push({
        file: userScriptName,
        line: Number(line),
        column: Number(col),
        raw: match[0].trim(),
      });
    }
  }

  return {
    name,
    message,
    stack,
    userFrames,
    userScriptLine: userFrames[0]?.line,
    userScriptColumn: userFrames[0]?.column,
  };
}

const userModulePath = `${requiredEnv("SWARM_SCRIPT_TMPDIR")}/user-script.ts`;
const errorFile = process.env.SWARM_SCRIPT_ERROR_FILE;

async function emitError(err: unknown): Promise<void> {
  const structured = buildStructuredError(err, userModulePath);
  const filtered = structured.userFrames.length
    ? `${structured.name}: ${structured.message}\n${structured.userFrames.map((f) => `    at ${f.file}:${f.line}:${f.column}`).join("\n")}`
    : structured.stack;
  console.error(filtered);
  if (errorFile) {
    try {
      await Bun.write(errorFile, JSON.stringify(structured));
    } catch {
      // Best-effort: if we can't write the structured error file, the stderr
      // text we already printed is the fallback.
    }
  }
}

try {
  const stdin = await Bun.stdin.text();
  if (!stdin.trim()) {
    await emitError(new Error("Swarm script config payload was empty"));
    process.exit(2);
  }

  const payload = JSON.parse(stdin) as SwarmConfigPayload;
  if (payload.egressSecrets?.length) {
    patchFetchWithEgressSubstitution(payload.egressSecrets);
  }
  const swarmConfig = new SwarmConfig(payload);
  const rawArgs = JSON.parse(await Bun.file(requiredEnv("SWARM_SCRIPT_ARGS_FILE")).text());
  // Accept both shapes: callers may pass an already-serialized JSON string.
  const parsedArgs = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
  const ctx = buildCtx({ swarmConfig, apiConnections: payload.apiConnections });

  const sourceText = await Bun.file(requiredEnv("SWARM_SCRIPT_SOURCE_FILE")).text();
  await Bun.write(userModulePath, sourceText);

  const mod = await import(userModulePath);
  if (typeof mod.default !== "function") {
    throw new Error("Swarm script must export a default function");
  }

  let validatedArgs = parsedArgs;
  if (mod.argsSchema && typeof mod.argsSchema === "object" && "parse" in mod.argsSchema) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: argsSchema is a Zod schema at runtime
      validatedArgs = (mod.argsSchema as any).parse(parsedArgs);
    } catch (err) {
      // Format ZodError issues into a readable message
      if (
        err &&
        typeof err === "object" &&
        "issues" in err &&
        Array.isArray((err as { issues: unknown[] }).issues)
      ) {
        const issues = (
          err as { issues: Array<{ path: (string | number)[]; message: string }> }
        ).issues
          .map((i) => `  ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
          .join("\n");
        throw new Error(`argsSchema validation failed:\n${issues}`);
      }
      throw err;
    }
  }

  const result = await mod.default(validatedArgs, ctx);
  await Bun.write(requiredEnv("SWARM_SCRIPT_RESULT_FILE"), JSON.stringify(result ?? null));
} catch (error) {
  await emitError(error);
  process.exit(1);
}
