/**
 * `SessionThread`'s pure dispatch model — no React, and only type imports
 * from `@/` (erased at runtime), so it stays unit-testable under `bun test`
 * without the component's hook/UI tree. See `session-thread.tsx`'s module doc
 * comment for the behavioral contract this implements.
 */

import { getByPath } from "@json-render/core";
import type { AgentTask } from "@/api/types";
import type { AttachmentLimits } from "@/components/sessions/composer-dock";
import { resolveScopedParams } from "./action-params";
import type { ActionChain } from "./catalog";
import { fileUploadPath, type UploadFn, uploadNonce } from "./form-file-model";
import { truncateText } from "./json-preview";

/** Longest person message shown per turn; the task page keeps the full prompt. */
export const SESSION_THREAD_MAX_REQUEST_CHARS = 4_000;

/**
 * `task.task` for an app-dispatched task is the FULL resolved agent prompt
 * from the `task.app.action` template (`src/prompts/session-templates.ts`):
 * the action's `prompt`, then a marker line
 * `[App action] app=<id> action=<name> input=<json>`, then further lines
 * (today `Caller (server-verified): <json>`). `input_json` is
 * `JSON.stringify(input)`, a single line, so the marker is matched line by
 * line and never assumed to be the last one. The last marker line wins, since
 * the configured `prompt` comes first and could quote one. A root test
 * renders the real template through this parser so the two cannot drift.
 */
const APP_ACTION_MARKER_LINE = /^\[App action\] app=\S+ action=\S+ input=(\{.*\})[ \t]*$/gm;

/** The input of an app-dispatched task's marker line, or `null` with no marker or malformed JSON. */
function appActionInput(task: Pick<AgentTask, "task">): Record<string, unknown> | null {
  let inputJson: string | undefined;
  for (const match of task.task.matchAll(APP_ACTION_MARKER_LINE)) inputJson = match[1];
  if (inputJson === undefined) return null;
  try {
    const input: unknown = JSON.parse(inputJson);
    return input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The person's message in an app-dispatched task (`input.message` of its
 * marker line), or `null` for a task with no marker, no `message`, or
 * malformed input JSON.
 */
export function appActionMessage(task: Pick<AgentTask, "task">): string | null {
  const message = appActionInput(task)?.message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

/** A file sent with a thread message: an item of `$form.attachments`, and a chip on its bubble. */
export interface ThreadAttachment {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

/** An absolute agent-fs path without `..`. */
export function isAgentFsPath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.split("/").includes("..");
}

function isThreadAttachment(value: unknown): value is ThreadAttachment {
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    isAgentFsPath(item.path) &&
    typeof item.name === "string" &&
    typeof item.mimeType === "string" &&
    typeof item.size === "number" &&
    Number.isFinite(item.size)
  );
}

/**
 * The files of an app-dispatched task (`input.attachments` of its marker
 * line, the shape `$form.attachments` has), for the person bubble. Only
 * `api` tasks qualify, as in `threadRequestText`. Malformed items are left out.
 */
export function threadRequestAttachments(task: AgentTask): ThreadAttachment[] {
  if (task.source !== "api") return [];
  const attachments = appActionInput(task)?.attachments;
  return Array.isArray(attachments) ? attachments.filter(isThreadAttachment) : [];
}

/** The `SessionThread.attachments` prop, read at runtime: a bound value can be anything. */
export interface ThreadAttachmentConfig {
  dir: unknown;
  limits: AttachmentLimits;
}

/** Files per message when `attachments.maxFiles` is not set. */
export const SESSION_THREAD_DEFAULT_MAX_FILES = 10;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The thread's attachment settings, or `null` without the prop. `accept` and
 * `maxBytes` fall back to the composer's own (`defaults`), `maxFiles` to
 * `SESSION_THREAD_DEFAULT_MAX_FILES`.
 */
export function threadAttachmentConfig(
  value: unknown,
  defaults: AttachmentLimits,
): ThreadAttachmentConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prop = value as Record<string, unknown>;
  const accept = Array.isArray(prop.accept)
    ? prop.accept.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
  return {
    dir: prop.dir,
    limits: {
      accept: accept.length > 0 ? accept : defaults.accept,
      maxBytes: positiveInteger(prop.maxBytes) ?? defaults.maxBytes,
      maxFiles: positiveInteger(prop.maxFiles) ?? SESSION_THREAD_DEFAULT_MAX_FILES,
    },
  };
}

/**
 * Uploads a message's files before its dispatch: create-only, one at a time,
 * to `<dir>/<timestamp>-<nonce>-<n>-<name>` (the Form file-field naming). Any
 * failure rejects, so the thread sends nothing and keeps the text and files.
 * A file uploaded before the failure stays in the folder; a retry uploads it
 * again under a new name. `upload` is null when agent-fs is not connected.
 */
export async function uploadThreadAttachments(input: {
  files: readonly File[];
  dir: unknown;
  upload: UploadFn | null;
  now?: Date;
  /** Test seam; defaults to a fresh `uploadNonce()` per message. */
  nonce?: string;
}): Promise<ThreadAttachment[]> {
  if (input.files.length === 0) return [];
  if (!isAgentFsPath(input.dir)) {
    throw new Error("This thread's attachments.dir is not an agent-fs folder path.");
  }
  const upload = input.upload;
  if (!upload) throw new Error("Connect agent-fs to send files, then send again.");
  const now = input.now ?? new Date();
  const nonce = input.nonce ?? uploadNonce();
  const uploaded: ThreadAttachment[] = [];
  for (const [index, file] of input.files.entries()) {
    const target = fileUploadPath(input.dir, file.name, now, nonce, index + 1);
    try {
      const path = await upload(target, file);
      uploaded.push({
        path,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${file.name} failed to upload (${reason}), so nothing was sent. Send again to retry.`,
      );
    }
  }
  return uploaded;
}

/**
 * The person bubble text of a thread turn (`TurnTimeline`'s `requestText`):
 * the app action's message, capped at `SESSION_THREAD_MAX_REQUEST_CHARS`.
 * Only `api` tasks qualify (`app.action` creates its tasks with that source),
 * so a worker task whose prompt quotes a marker stays a worker step. Null:
 * the timeline's own rules place the task.
 */
export function threadRequestText(task: AgentTask): string | null {
  if (task.source !== "api") return null;
  const message = appActionMessage(task);
  return message === null ? null : truncateText(message, SESSION_THREAD_MAX_REQUEST_CHARS);
}

/** A SessionThread session as the `app.action` route takes it (`body.session`). */
export interface ThreadSession {
  key: string;
  scope: "user" | "shared";
}

/** Mirrors the server's `APP_SESSION_KEY_PATTERN` (`src/tasks/context-key.ts`). */
const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSessionKey(key: unknown): key is string {
  return typeof key === "string" && SESSION_KEY_PATTERN.test(key);
}

/**
 * The context key the server gives a user-scoped session's tasks
 * (`appSessionContextKey` in `src/tasks/context-key.ts`). The client only
 * reads with it, to find the viewer's session; the server builds it on write.
 */
export function threadContextKey(appId: string, sessionKey: string, userId: string): string {
  return `task:app:${appId}:${sessionKey}:user:${userId}`;
}

/**
 * The session root to show: the newest listed root whose `contextKey` is
 * exactly `contextKey` (the list filters by prefix) and, after "New
 * session", that was created after `after`. Null when there is none yet.
 */
export function pickSessionRoot<T extends Pick<AgentTask, "id" | "createdAt" | "contextKey">>(
  roots: readonly T[],
  contextKey: string,
  after: string | null,
): T | null {
  let newest: T | null = null;
  for (const root of roots) {
    if (root.contextKey !== undefined && root.contextKey !== contextKey) continue;
    if (after !== null && root.createdAt <= after) continue;
    if (newest === null || root.createdAt > newest.createdAt) newest = root;
  }
  return newest;
}

export interface DispatchChainResult {
  /** The newly created task's id, read off `/actions/<name>` after an `app.action` step — undefined if no such step ran or it hasn't landed yet. */
  newTaskId: string | undefined;
}

/** An `app.action` slot as `app-surface.tsx` writes it to `/actions/<name>`. */
interface ActionSlotView {
  status?: string;
  taskId?: string;
  error?: string;
}

/**
 * Pure orchestration for `onDispatch` — no React, so it's testable with a
 * mock `execute`/`getSnapshot`. Mirrors `app-surface.tsx`'s `"app.action"`
 * handler contract: that handler writes its response (incl. `taskId`) to
 * `/actions/<name>` (or `/refs/<app>/actions/<name>` for a borrowed
 * instance) SYNCHRONOUSLY before `execute` resolves — that's the only way to
 * learn the newly created task's id, since `execute` itself returns void.
 *
 * Every `app.action` step carries the thread's `session` (always: the
 * thread finds its session by that key, so a step must not write elsewhere)
 * and `followUp: false` unless the step sets `followUp` itself.
 */
export async function runDispatchChain(options: {
  onDispatch: ActionChain | undefined;
  message: string;
  /** The leaf to chain under, or `null` when the viewer has no session yet. */
  leafTaskId: string | null;
  /** The message's uploaded files, with the `attachments` prop; omitted, `$form` has no key for them. */
  attachments?: readonly ThreadAttachment[];
  session: ThreadSession;
  execute: (binding: { action: string; params?: Record<string, unknown> }) => Promise<void>;
  getSnapshot: () => Record<string, unknown>;
}): Promise<DispatchChainResult> {
  const { onDispatch, message, leafTaskId, attachments, session, execute, getSnapshot } = options;
  if (!onDispatch || onDispatch.length === 0) return { newTaskId: undefined };

  // Explicit absence: every chain key is published, `null` when there is no
  // value yet. With no session `leafTaskId` is `null`, so a
  // `"parentTaskId": { "$chain": "leafTaskId" }` param is dropped and the
  // first message creates the session's root task (see `resolveScopedValue`).
  const scope = {
    form: attachments === undefined ? { message } : { message, attachments: [...attachments] },
    state: getSnapshot(),
    chain: { leafTaskId, newTaskId: null },
  };
  let newTaskId: string | undefined;
  for (const binding of onDispatch) {
    const params = resolveScopedParams(binding.params, scope);
    if (binding.action === "app.action") {
      params.session = { key: session.key, scope: session.scope };
      // One task per message: no Lead follow-up (the review that would join
      // the chain) unless the step asks for one.
      if (!Object.hasOwn(params, "followUp")) params.followUp = false;
    }
    await execute({ ...binding, params });
    if (binding.action === "app.action" && typeof params.name === "string") {
      const slotPath =
        typeof params.$app === "string"
          ? `/refs/${params.$app}/actions/${params.name}`
          : `/actions/${params.name}`;
      const slot = getByPath(getSnapshot(), slotPath) as ActionSlotView | undefined;
      // The handler reports a failure on the slot instead of throwing; stop the
      // chain so later steps never run on a failed send.
      if (slot?.status === "error") {
        throw new Error(slot.error || `Action ${params.name} failed`);
      }
      if (slot?.taskId) newTaskId = slot.taskId;
    }
  }
  return { newTaskId };
}

/**
 * The app a thread's `app.action` steps run on: the `$app` the assembler
 * tags a borrowed element's steps with, else the page's own app. The session
 * key is built from it server-side, so the lookup must use the same id.
 */
export function dispatchAppId(onDispatch: ActionChain | undefined, pageAppId: string | null) {
  for (const binding of onDispatch ?? []) {
    const appParam = binding.action === "app.action" ? binding.params?.$app : undefined;
    if (typeof appParam === "string" && appParam !== "") return appParam;
  }
  return pageAppId;
}

/**
 * Whether a send that created `pendingTaskId` has shown up: the chain holds
 * the task, or (first send) the page bound the new root. Until then the send
 * stays pending, so a quick second message cannot chain off the old leaf or
 * start a second root.
 */
export function isDispatchSettled(input: {
  pendingTaskId: string | null;
  rootTaskId: string;
  chain: readonly Pick<AgentTask, "id">[];
}): boolean {
  const { pendingTaskId, rootTaskId, chain } = input;
  if (pendingTaskId === null) return true;
  if (rootTaskId === pendingTaskId) return true;
  return chain.some((task) => task.id === pendingTaskId);
}
