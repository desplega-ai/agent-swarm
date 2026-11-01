/**
 * Internal-AI: reusable structured-output LLM abstraction for both worker
 * subprocesses and the API server.
 *
 * Plan: thoughts/taras/plans/2026-05-10-fix-session-summarization-workers.md
 *
 * Worker-safe: uses fetch() only, no bun:sqlite import.
 *
 * Public surface:
 *   - `completeStructured<TZod>({...})` — context-agnostic lower layer.
 *   - `summarizeSession({...})` — worker-side session-end domain helper.
 *   - `resolveCredential({...})` — exposed for opencode-auth and tests.
 */

export {
  type CompleteStructuredOptions,
  type CompleteStructuredResult,
  completeStructured,
  completeStructuredWithModel,
} from "./complete-structured.js";
export {
  CREDENTIAL_KIND_PRECEDENCE,
  type CredentialKind,
  DEFAULT_MODEL,
  type ResolveCredentialOptions,
  type ResolveCredentialsOptions,
  type ResolvedCredential,
  resolveCredential,
  resolveCredentials,
} from "./credentials.js";
export {
  MEMORY_RATER_DEFAULT_MODEL,
  parseModelStr,
  resolveRaterModelString,
} from "./models.js";
export {
  type SummarizeSessionOptions,
  type SummarizeSessionResult,
  summarizeSession,
  summaryToolSchema,
} from "./summarize-session.js";
export {
  type GenerateTaskTitleOptions,
  type GenerateTaskTitleResult,
  generateTaskTitle,
  TASK_TITLE_MODEL_CANDIDATES,
  TASK_TITLE_MODEL_ENV,
} from "./task-title.js";
