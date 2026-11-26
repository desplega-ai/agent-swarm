/**
 * Typed errors for failed `ctx.swarm.*`, `ctx.<namespace>.*` and `ctx.db.query`
 * calls. A script branches on `err.code` (or `err instanceof SwarmToolError`)
 * instead of matching message text. Messages keep their old wording.
 *
 * One JavaScript source serves the native SDK, the QuickJS sandbox and the
 * QuickJS `swarm-sdk` virtual module. It caches the class on a global
 * `Symbol.for` key, so the native harness's own SDK copy and the user script's
 * `import { SwarmToolError } from "swarm-sdk"` (a separate bundle in compiled
 * mode) share one class and `instanceof` holds across them.
 */
export const SWARM_TOOL_ERROR_CODES = [
  "unknown_tool",
  "not_exposed",
  "invalid_args",
  "permission",
  "not_found",
  "rate_limited",
  "timeout",
  "refused",
  "upstream",
] as const;

export type SwarmToolErrorCode = (typeof SWARM_TOOL_ERROR_CODES)[number];

export interface SwarmToolErrorInit {
  code: SwarmToolErrorCode;
  /** The SDK method the script called, e.g. `kv_get` (or the unknown name it asked for). */
  tool: string;
  /** HTTP status of the failed bridge call, when there was one. */
  status?: number;
  /** Closest exposed tool names, for `unknown_tool`. */
  suggestions?: string[];
  cause?: unknown;
}

export interface SwarmToolError extends Error {
  readonly name: "SwarmToolError";
  readonly code: SwarmToolErrorCode;
  readonly tool: string;
  readonly status?: number;
  readonly suggestions?: string[];
}

export interface SwarmToolErrorConstructor {
  new (message: string, init: SwarmToolErrorInit): SwarmToolError;
  /** True for a SwarmToolError, also one rebuilt in another realm (name + code match). */
  is(value: unknown): value is SwarmToolError;
}

/** Shared JavaScript source; evaluates to the (global, cached) SwarmToolError class. */
export const SWARM_TOOL_ERROR_JS = `(() => {
  const key = Symbol.for("agent-swarm.SwarmToolError");
  if (globalThis[key]) return globalThis[key];
  class SwarmToolError extends Error {
    constructor(message, init) {
      super(message);
      const options = init || {};
      this.name = "SwarmToolError";
      this.code = options.code || "upstream";
      this.tool = options.tool || "";
      if (typeof options.status === "number") this.status = options.status;
      if (Array.isArray(options.suggestions)) this.suggestions = options.suggestions.slice();
      if (options.cause !== undefined) this.cause = options.cause;
    }
    static is(value) {
      return value instanceof SwarmToolError || (value !== null && typeof value === "object" &&
        value.name === "SwarmToolError" && typeof value.code === "string");
    }
  }
  Object.defineProperty(globalThis, key, { value: SwarmToolError });
  return SwarmToolError;
})()`;

export const SwarmToolError: SwarmToolErrorConstructor = new Function(
  `return ${SWARM_TOOL_ERROR_JS};`,
)();

/** The error code for a failed bridge call's HTTP status. */
export function swarmToolErrorCodeForStatus(status: number): SwarmToolErrorCode {
  if (status === 400 || status === 422) return "invalid_args";
  if (status === 401 || status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  return "upstream";
}

/** A SwarmToolError for a non-2xx bridge response. */
export function swarmToolHttpError(tool: string, status: number, message: string): SwarmToolError {
  return new SwarmToolError(message, {
    code: swarmToolErrorCodeForStatus(status),
    tool,
    ...(status > 0 ? { status } : {}),
  });
}

/**
 * The typed form of an error a bridge call threw (network failure, oversize
 * response, bad JSON). An AbortError means the run is ending and passes through.
 */
export function toSwarmToolError(tool: string, error: unknown): unknown {
  if (SwarmToolError.is(error)) return error;
  if (error instanceof Error && error.name === "AbortError") return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "upstream";
  return new SwarmToolError(message, { code, tool, cause: error });
}

/** The fields that carry a SwarmToolError across the QuickJS JSON boundary. */
export function swarmToolErrorFields(
  error: unknown,
): Pick<SwarmToolErrorInit, "code" | "tool" | "status" | "suggestions"> | undefined {
  if (!SwarmToolError.is(error)) return undefined;
  return {
    code: error.code,
    tool: error.tool,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.suggestions ? { suggestions: error.suggestions } : {}),
  };
}
