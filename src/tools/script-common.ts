import * as z from "zod";
import { getApiKey } from "@/utils/api-key";
import { getMcpBaseUrl } from "@/utils/constants";
import {
  type RequestInfo,
  type SwarmToolResult,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "./utils";

export const SCRIPT_TRANSPORT_ERROR =
  "script_* tools require HTTP MCP transport — agent identity is not available over stdio in this build. Switch to MCP_BASE_URL=http://... or invoke the HTTP API directly.";

export const scriptNameSchema = z.string().min(1).max(200);
export const scriptScopeSchema = z.enum(["agent", "global"]);
export const scriptFsModeSchema = z.enum(["none", "workspace-rw"]);

export const scriptToolOutputSchema = swarmToolOutputSchema({
  status: z.number().optional(),
  data: z.unknown().optional(),
});

const DETAILS_CAP = 16_000;

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal color codes
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function capDetails(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (text.length <= DETAILS_CAP) return text;
  return `${text.slice(0, DETAILS_CAP)}\n… [truncated ${text.length - DETAILS_CAP} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiBaseUrl(): string {
  return getMcpBaseUrl();
}

type ScriptFailure = { message: string; details?: string };

/**
 * Honest failure detection for the scripts API. The API returns HTTP 200 for
 * script runs that failed at runtime (error / runtimeError / exitCode live in
 * the body) and durable runs carry `run.status` / `run.error` — trusting
 * `res.ok` alone reports failures as successes.
 */
function describeScriptFailure(
  resOk: boolean,
  status: number,
  data: unknown,
): ScriptFailure | undefined {
  const body = isRecord(data) ? data : undefined;

  if (!resOk) {
    const error = body && "error" in body ? String(body.error) : undefined;

    // Typecheck rejection: fold real diagnostics instead of the literal "typecheck_failed".
    const diagnostics =
      body && Array.isArray(body.diagnostics)
        ? (body.diagnostics as unknown[]).map((d) => stripAnsi(String(d)))
        : undefined;
    if (error === "typecheck_failed" && diagnostics && diagnostics.length > 0) {
      const more = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : "";
      const firstLine = diagnostics[0]?.split("\n")[0] ?? "unknown diagnostic";
      return {
        message: `Typecheck failed: ${firstLine}${more}`,
        details: capDetails(diagnostics.join("\n\n")),
      };
    }

    // Label-lint / policy rejections: fold violation detail.
    const violations =
      body && Array.isArray(body.violations) ? (body.violations as unknown[]) : undefined;
    if (violations && violations.length > 0) {
      return {
        message: `${error ?? `Scripts API request failed with ${status}`} — ${violations.length} violation(s)`,
        details: capDetails(
          violations.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n"),
        ),
      };
    }

    return { message: error ?? `Scripts API request failed with ${status}` };
  }

  // HTTP 200 inline-run body: failure signalled inside the payload.
  if (body && ("exitCode" in body || "runtimeError" in body || "stderr" in body)) {
    const runtimeError = isRecord(body.runtimeError)
      ? `${String(body.runtimeError.name ?? "Error")}: ${String(body.runtimeError.message ?? "")}`
      : undefined;
    const error = typeof body.error === "string" && body.error ? body.error : undefined;
    const exitCode = typeof body.exitCode === "number" ? body.exitCode : 0;
    if (error || runtimeError || exitCode !== 0) {
      const reason =
        [error, runtimeError].filter(Boolean).join(" — ") || `script exited with code ${exitCode}`;
      const stderr =
        typeof body.stderr === "string" && body.stderr.trim() ? body.stderr.trim() : undefined;
      return {
        message: `Script run failed: ${reason}`,
        details: capDetails(stderr ? `stderr:\n${stderr}` : undefined),
      };
    }
  }

  // Durable run body: { run: { status, error, ... } }.
  if (body && isRecord(body.run) && body.run.status === "failed") {
    const runError =
      typeof body.run.error === "string" && body.run.error ? body.run.error : "unknown error";
    return {
      message: `Script run ${String(body.run.id ?? "")} failed: ${runError}`.replace("  ", " "),
    };
  }

  return undefined;
}

export async function proxyScriptsApi(args: {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  requestInfo: RequestInfo;
  successMessage: (data: unknown) => string;
  /** Optional model-facing rendering of the success payload (appended to the text channel). */
  successDetails?: (data: unknown) => string | undefined;
  /**
   * Optional model-facing rendering of the payload when the call fails, used
   * when the failure itself carries no details (e.g. a failed durable run whose
   * journal holds the step errors).
   */
  failureDetails?: (data: unknown) => string | undefined;
  /**
   * Skip the generic details cap. Only for payloads that are authoritative in
   * full (e.g. script-query-types' type blobs, which exceed the cap and have
   * no pagination) — everything else stays capped.
   */
  uncappedDetails?: boolean;
}): Promise<SwarmToolResult> {
  if (!args.requestInfo.agentId) return toolErr(SCRIPT_TRANSPORT_ERROR);

  const apiKey = getApiKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "X-Agent-ID": args.requestInfo.agentId,
    "Content-Type": "application/json",
  };
  if (args.requestInfo.sourceTaskId) {
    headers["X-Source-Task-Id"] = args.requestInfo.sourceTaskId;
  }
  const res = await fetch(`${apiBaseUrl()}${args.path}`, {
    method: args.method,
    headers,
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });

  const text = await res.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  const toolData = { status: res.status, data };
  const failure = describeScriptFailure(res.ok, res.status, data);
  if (failure) {
    return toolErr(failure.message, {
      details: failure.details ?? capDetails(args.failureDetails?.(data)),
      data: toolData,
    });
  }

  const successDetails = args.successDetails?.(data);
  return toolOk(args.successMessage(data), {
    details: args.uncappedDetails ? successDetails : capDetails(successDetails),
    data: toolData,
  });
}
