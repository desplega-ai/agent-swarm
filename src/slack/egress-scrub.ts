import { webApi } from "@slack/bolt";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";

/**
 * Client-level secret scrub for every outbound Slack write.
 *
 * There is no shared Slack send function: tools, the watcher, the thread
 * buffer and Bolt listeners each call `client.chat.*` directly. So the scrub
 * sits on `WebClient` itself. `@slack/web-api` binds every method to
 * `this.apiCall` at construction, so an instance-level override would be a
 * no-op; patching the prototype before any client is built covers Bolt's
 * `app.client` and the per-request clients it hands to listeners.
 */

/** Methods whose arguments carry user-visible text. */
const WRITE_METHODS = new Set([
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.update",
  "chat.scheduleMessage",
  "chat.meMessage",
  "files.completeUploadExternal",
]);

/** Argument fields that may carry free text (strings, Block Kit, JSON strings). */
const TEXT_FIELDS = ["text", "blocks", "attachments", "initial_comment", "title", "files"] as const;

type Args = Record<string, unknown>;

function scrubFields(args: Args, fields: readonly string[]): Args {
  const out: Args = { ...args };
  for (const field of fields) {
    if (out[field] !== undefined) out[field] = scrubObject(out[field]);
  }
  return out;
}

/** Scrub the text-bearing fields of a Slack Web API write. Other methods pass through. */
function scrubSlackWriteArgs(method: string, args: Args | undefined): Args | undefined {
  if (!args || !WRITE_METHODS.has(method)) return args;
  return scrubFields(args, TEXT_FIELDS);
}

/**
 * Scrub a `files.uploadV2` call. String `content` is text the bot is about to
 * publish, so it is scrubbed; `file` (a path or a Buffer) is binary-safe and
 * passes through byte-identical.
 */
function scrubSlackUploadArgs<T extends object>(options: T): T {
  const out = scrubFields(options as Args, ["initial_comment", "title", "alt_text"]);
  if (typeof out.content === "string") out.content = scrubSecrets(out.content);
  if (Array.isArray(out.file_uploads)) {
    out.file_uploads = out.file_uploads.map((upload: unknown) => {
      if (!upload || typeof upload !== "object") return upload;
      const entry = scrubFields(upload as Args, ["title", "alt_text"]);
      if (typeof entry.content === "string") entry.content = scrubSecrets(entry.content);
      return entry;
    });
  }
  return out as T;
}

const INSTALLED = Symbol.for("agent-swarm.slack-egress-scrub");

type PatchableProto = {
  apiCall: (method: string, options?: Args) => Promise<unknown>;
  filesUploadV2: (options: object) => Promise<unknown>;
  [INSTALLED]?: true;
};

/**
 * Route every `WebClient` built after this call through the scrub. Idempotent.
 * Call it before the Bolt `App` (and its receiver) are constructed.
 */
export function installSlackEgressScrub(): void {
  const proto = webApi.WebClient.prototype as unknown as PatchableProto;
  if (proto[INSTALLED]) return;
  const originalApiCall = proto.apiCall;
  const originalUpload = proto.filesUploadV2;
  proto.apiCall = function (this: unknown, method: string, options?: Args) {
    return originalApiCall.call(this, method, scrubSlackWriteArgs(method, options));
  };
  proto.filesUploadV2 = function (this: unknown, options: object) {
    return originalUpload.call(this, scrubSlackUploadArgs(options));
  };
  proto[INSTALLED] = true;
}
