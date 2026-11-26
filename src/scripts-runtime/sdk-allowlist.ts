import { ALL_TOOLS } from "../tools/tool-config";
import { SwarmToolError } from "./swarm-tool-error";

export const SDK_TOOL_NAME_MAP = {
  // ── memory ──
  memory_search: "memory-search",
  memory_get: "memory-get",
  memory_edit: "memory-edit",
  memory_store: "memory-store",
  memory_rate: "memory_rate",
  memory_delete: "memory-delete", // destructive
  inject_learning: "inject-learning",

  // ── tasks ──
  task_list: "get-tasks",
  task_get: "get-task-details",
  task_storeProgress: "store-progress",
  task_defer: "defer-task",
  task_poll: "poll-task",
  task_send: "send-task",
  task_cancel: "cancel-task", // destructive
  task_steer: "steer-task", // destructive
  task_action: "task-action",

  // ── kv ──
  kv_get: "kv-get",
  kv_getOrNull: "kv-get",
  kv_set: "kv-set",
  kv_delete: "kv-delete",
  kv_del: "kv-delete",
  kv_incr: "kv-incr",
  kv_list: "kv-list",

  // ── realtime rooms ──
  room_get: "room-get",
  room_change: "room-change",
  room_reset: "room-reset",
  room_decode: "room-decode",

  // ── primitive objects (also ctx.objects, see SDK_NAMESPACES) ──
  objects_create: "object-create",
  objects_get: "object-get",
  objects_list: "object-list",
  objects_reindex: "object-reindex",

  // ── sheets (also ctx.sheets, see SDK_NAMESPACES) ──
  sheets_create: "sheet-create",
  sheets_get: "sheet-get",
  sheets_list: "sheet-list",
  sheets_getRange: "sheet-get-range",
  sheets_setRange: "sheet-set-range",
  sheets_appendRows: "sheet-append-rows",
  sheets_clearRange: "sheet-clear-range",
  sheets_addTab: "sheet-add-tab",
  sheets_importXlsx: "sheet-import-xlsx",
  sheets_exportXlsx: "sheet-export-xlsx",
  // ── data (also ctx.data, see SDK_NAMESPACES) ──
  data_query: "data-query",
  // ── boards (also ctx.boards, see SDK_NAMESPACES) ──
  boards_create: "board-create",
  boards_get: "board-get",
  boards_list: "board-list",
  boards_addElements: "board-add-elements",
  boards_updateElements: "board-update-elements",
  boards_removeElements: "board-remove-elements",

  // ── repos ──
  repo_list: "get-repos",
  repo_update: "update-repo",

  // ── schedules ──
  schedule_list: "list-schedules",
  schedule_create: "create-schedule",
  schedule_update: "update-schedule",
  schedule_patch: "patch-schedule",
  schedule_delete: "delete-schedule", // destructive
  schedule_runNow: "run-schedule-now",

  // ── scripts ──
  script_search: "script-search",
  script_run: "script-run",
  script_upsert: "script-upsert",
  script_delete: "script-delete", // destructive
  script_queryTypes: "script-query-types",
  script_launchRun: "launch-script-run",
  script_getRun: "get-script-run",
  script_listRuns: "list-script-runs",

  // ── extensions ──
  extension_delete: "extension-delete",
  extension_enable: "extension-enable",
  extension_disable: "extension-disable",
  extension_activate_version: "extension-activate-version",
  extension_catalog: "extension-catalog",
  extension_install: "extension-install",
  extension_list: "extension-list",
  runtime_pool_list: "runtime-pool-list",
  runtime_pool_upsert: "runtime-pool-upsert",
  runtime_pool_delete: "runtime-pool-delete",
  runtime_pool_bind_agent: "runtime-pool-bind-agent",
  runtime_pool_create_agent: "runtime-pool-create-agent",
  runtime_controller_list: "runtime-controller-list",

  // ── swarm / agent ──
  swarm_get: "get-swarm",
  agent_info: "my-agent-info",
  agent_join: "join-swarm",
  metrics_get: "get-metrics",
  user_resolve: "resolve-user",
  user_manage: "manage-user",
  db_query: "db-query",

  // ── config ──
  config_get: "get-config",
  config_list: "list-config",
  config_set: "set-config",
  config_delete: "delete-config", // destructive

  // ── model catalog ──
  modelCatalog_refresh: "model-catalog-refresh", // external: fetches models.dev
  modelCatalog_overlayUpsert: "model-catalog-overlay-upsert",
  modelProfile_list: "list-model-profiles",
  modelProfile_check: "check-model-profile",

  // ── slack ──
  slack_read: "slack-read",
  slack_listChannels: "slack-list-channels",
  slack_post: "slack-post", // external: sends to Slack
  slack_reply: "slack-reply", // external: sends to Slack
  slack_startThread: "slack-start-thread", // external: sends to Slack
  slack_createChannel: "slack-create-channel", // external: mutates Slack
  slack_inviteToChannel: "slack-invite-to-channel", // external: mutates Slack
  slack_archiveChannel: "slack-archive-channel", // external: mutates Slack
  slack_uploadFile: "slack-upload-file", // external: sends to Slack
  slack_downloadFile: "slack-download-file",
  slack_delete: "slack-delete", // external: mutates Slack, destructive
  slack_update: "slack-update", // external: mutates Slack
  slack_leaveThread: "slack-leave-thread",

  // ── chat sdk ──
  chat_reply: "chat-reply", // external: sends to the task's chat thread
  chat_post: "chat-post", // external: sends to a chat platform
  chat_openDm: "chat-open-dm", // external: opens a platform DM
  chat_readThread: "chat-read-thread",
  chat_registerChannel: "register-chat-channel",
  chat_unregisterChannel: "unregister-chat-channel", // destructive

  // ── messaging (internal) ──
  message_read: "read-messages",
  message_post: "post-message",

  // ── profiles ──
  profile_update: "update-profile",

  // ── context / profiles ──
  context_history: "context-history",
  context_diff: "context-diff",

  // ── workflows ──
  workflow_list: "list-workflows",
  workflow_get: "get-workflow",
  workflow_create: "create-workflow",
  workflow_update: "update-workflow",
  workflow_patch: "patch-workflow",
  workflow_patchNode: "patch-workflow-node",
  workflow_delete: "delete-workflow", // destructive
  workflow_trigger: "trigger-workflow",
  workflow_listRuns: "list-workflow-runs",
  workflow_getRun: "get-workflow-run",
  workflow_retryRun: "retry-workflow-run",
  workflow_cancelRun: "cancel-workflow-run", // destructive

  // ── prompt templates ──
  prompt_list: "list-prompt-templates",
  prompt_get: "get-prompt-template",
  prompt_set: "set-prompt-template",
  prompt_delete: "delete-prompt-template", // destructive
  prompt_preview: "preview-prompt-template",

  // ── tracker ──
  tracker_status: "tracker-status",
  tracker_syncStatus: "tracker-sync-status",
  tracker_linkTask: "tracker-link-task",
  tracker_unlink: "tracker-unlink", // destructive
  tracker_mapAgent: "tracker-map-agent",

  // ── skills ──
  skill_list: "skill-list",
  skill_get: "skill-get",
  skill_getFile: "skill-get-file",
  skill_search: "skill-search",
  skill_create: "skill-create",
  skill_update: "skill-update",
  skill_delete: "skill-delete", // destructive
  skill_install: "skill-install",
  skill_uninstall: "skill-uninstall", // destructive
  skill_publish: "skill-publish",

  // ── mcp servers ──
  mcpServer_list: "mcp-server-list",
  mcpServer_get: "mcp-server-get",
  mcpServer_create: "mcp-server-create",
  mcpServer_update: "mcp-server-update",
  mcpServer_delete: "mcp-server-delete", // destructive
  mcpServer_install: "mcp-server-install",
  mcpServer_uninstall: "mcp-server-uninstall", // destructive

  // ── pages & metrics ──
  app_catalog: "app-catalog",
  app_get: "app-get",
  app_history: "app-history",
  app_diff: "app-diff",
  app_list: "app-list",
  app_patch: "app-patch",
  app_patchNode: "app-patch-node",
  app_query: "app-query",
  app_rows_list: "app-rows-list",
  app_row_get: "app-row-get",
  app_row_create: "app-row-create",
  app_rows_create: "app-rows-create",
  app_row_patch: "app-row-patch",
  app_row_delete: "app-row-delete",
  app_rows_delete: "app-rows-delete",
  app_rollback: "app-rollback",
  app_sync: "app-sync",
  app_upsert: "app-upsert",
  page_create: "create_page",
  page_delete: "delete-page", // destructive
  designSystem_get: "design-system-get",
  designSystem_set: "design-system-set",
  metric_create: "create_metric",

  // ── human input ──
  request_humanInput: "request-human-input",
  approval_cancel: "cancel-approval-request", // destructive

  // ── decisions ──
  systemOne_decide: "system-one-decide",
} as const;

export const SDK_ALLOWLIST = Object.keys(SDK_TOOL_NAME_MAP) as Array<
  keyof typeof SDK_TOOL_NAME_MAP
>;

/** Set of MCP tool names (values of SDK_TOOL_NAME_MAP) that scripts may call via the bridge. */
const MCP_TOOL_NAMES: ReadonlySet<string> = new Set<string>(Object.values(SDK_TOOL_NAME_MAP));

/**
 * SDK methods backed by a REST route with no MCP tool, mapped in `bridgeRequestFor`.
 * Scripts only: they are not in SDK_TOOL_NAME_MAP, so the MCP bridge, the workflow
 * capability list and the MCP-tool registration check never see them.
 */
export const REST_ONLY_SDK_METHODS = ["savings_calibrationGet", "savings_calibrationRun"] as const;

export function isSdkToolAllowed(name: string): boolean {
  return (
    (SDK_ALLOWLIST as readonly string[]).includes(name) ||
    (REST_ONLY_SDK_METHODS as readonly string[]).includes(name)
  );
}

/** True if `mcpToolName` (e.g. "trigger-workflow") corresponds to an allowlisted SDK method. */
export function isMcpToolAllowedForScripts(mcpToolName: string): boolean {
  return MCP_TOOL_NAMES.has(mcpToolName);
}

export function mcpToolNameForSdkMethod(name: string): string {
  return SDK_TOOL_NAME_MAP[name as keyof typeof SDK_TOOL_NAME_MAP] ?? name;
}

const normalizeToolName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Longest `ctx.swarm.<name>` the name lookups read. Every SDK and MCP tool name
 * is far shorter, so a longer name can match none of them; checking first keeps
 * the host from normalizing or aligning a name of any size the script sends.
 */
const MAX_LOOKUP_NAME_LENGTH = 128;

type ToolNameIndex = {
  /** Each callable SDK method with its normalized spellings: method, MCP tool name, method suffix. */
  methods: Array<{ method: string; forms: string[] }>;
  /** Normalized MCP tool names that are deliberately not exposed to scripts. */
  excluded: ReadonlySet<string>;
};

let toolNameIndex: ToolNameIndex | undefined;

function getToolNameIndex(): ToolNameIndex {
  if (toolNameIndex) return toolNameIndex;
  const methods = [...SDK_ALLOWLIST, ...REST_ONLY_SDK_METHODS].map((method: string) => {
    const suffix = method.slice(method.indexOf("_") + 1);
    const forms = new Set([method, mcpToolNameForSdkMethod(method), suffix].map(normalizeToolName));
    return { method, forms: [...forms] };
  });
  // Every MCP tool is either in SDK_TOOL_NAME_MAP or excluded on purpose
  // (scripts/check-sdk-tool-registration.ts), so the rest of ALL_TOOLS is the exclusion list.
  const excluded = new Set(
    [...ALL_TOOLS].filter((tool) => !MCP_TOOL_NAMES.has(tool)).map(normalizeToolName),
  );
  toolNameIndex = { methods, excluded };
  return toolNameIndex;
}

/** Optimal string alignment distance: edits, with an adjacent swap counted as one. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = rows[i] as number[];
      const prev = rows[i - 1] as number[];
      let best = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((rows[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = best;
    }
  }
  return (rows[a.length] as number[])[b.length] as number;
}

const MAX_SUGGESTIONS = 3;

/** Up to three exposed SDK methods whose name is closest to `name` (case, `-` and `_` ignored). */
export function suggestSdkTools(name: string): string[] {
  if (name.length > MAX_LOOKUP_NAME_LENGTH) return [];
  const wanted = normalizeToolName(name);
  if (!wanted) return [];
  const limit = Math.max(1, Math.min(3, Math.floor(wanted.length / 3)));
  const ranked = getToolNameIndex()
    .methods.map(({ method, forms }) => ({
      method,
      // The distance is at least the length difference: skip forms that cannot be within `limit`.
      distance: Math.min(
        ...forms
          .filter((form) => Math.abs(form.length - wanted.length) <= limit)
          .map((form) => editDistance(wanted, form)),
      ),
    }))
    .filter(({ distance }) => distance <= limit)
    .sort((a, b) => a.distance - b.distance || a.method.localeCompare(b.method));
  // A respelling (`db-query`, `dbQuery`) names its method alone.
  const exact = ranked.filter(({ distance }) => distance === 0);
  return (exact.length > 0 ? exact : ranked).slice(0, MAX_SUGGESTIONS).map(({ method }) => method);
}

/**
 * The error for a `ctx.swarm.<name>` call that is not an SDK method: `not_exposed`
 * for a tool kept from scripts on purpose (lifecycle, credentials), else
 * `unknown_tool` with the closest method names. A different spelling of an
 * exposed method (`db-query`, `dbQuery`) is `unknown_tool` and suggests it.
 */
export function unavailableSdkToolError(name: string): SwarmToolError {
  if (
    name.length <= MAX_LOOKUP_NAME_LENGTH &&
    getToolNameIndex().excluded.has(normalizeToolName(name))
  ) {
    return new SwarmToolError(
      `Tool '${name}' is not exposed to scripts (lifecycle/cred tool); use the MCP surface directly if you're an agent`,
      { code: "not_exposed", tool: name },
    );
  }
  const suggestions = suggestSdkTools(name);
  const hint =
    suggestions.length > 0
      ? `Did you mean ${suggestions.map((method) => `ctx.swarm.${method}`).join(", ")}?`
      : "No exposed tool has a similar name.";
  return new SwarmToolError(`Tool '${name}' is not exposed to scripts (unknown tool). ${hint}`, {
    code: "unknown_tool",
    tool: name,
    suggestions,
  });
}

/** `{ ns: methods }`: `ctx.<ns>.<m>(args)` calls SDK method `<ns>_<m>` and returns its unwrapped result. */
export type SdkNamespaceRegistry = Readonly<Record<string, readonly string[]>>;

/**
 * Tool groups exposed as top-level `ctx.<ns>` namespaces in native and QuickJS
 * scripts and in script workflows. A new entry also needs its `<ns>_<m>`
 * methods in SDK_TOOL_NAME_MAP and a typed key on `ScriptContext` in
 * `src/be/scripts/typecheck.ts`.
 */
export const SDK_NAMESPACES: SdkNamespaceRegistry = Object.freeze({
  objects: ["create", "get", "list", "reindex"],
  sheets: [
    "create",
    "get",
    "list",
    "getRange",
    "setRange",
    "appendRows",
    "clearRange",
    "addTab",
    "importXlsx",
    "exportXlsx",
  ],
  boards: ["create", "get", "list", "addElements", "updateElements", "removeElements"],
  data: ["query"],
});

/** ctx keys a namespace may never shadow. */
export const RESERVED_CTX_KEYS: readonly string[] = [
  "swarm",
  "api",
  "mcp",
  "fs",
  "sh",
  "db",
  "stdlib",
  "logger",
  "run",
  "step",
  "config",
  "caller",
];

const NAMESPACE_NAME = /^[a-z][a-zA-Z]*$/;

export function sdkMethodForNamespace(ns: string, method: string): string {
  return `${ns}_${method}`;
}

/** Throws unless every namespace is unreserved, well-named and maps to allowlisted SDK methods. */
export function assertNamespaces(registry: SdkNamespaceRegistry): void {
  for (const [ns, methods] of Object.entries(registry)) {
    if (!NAMESPACE_NAME.test(ns)) throw new Error(`SDK namespace '${ns}' has an invalid name`);
    if (RESERVED_CTX_KEYS.includes(ns)) throw new Error(`SDK namespace '${ns}' is reserved`);
    for (const method of methods) {
      if (!NAMESPACE_NAME.test(method)) {
        throw new Error(`SDK namespace method '${ns}.${method}' has an invalid name`);
      }
      const sdkMethod = sdkMethodForNamespace(ns, method);
      if (!Object.hasOwn(SDK_TOOL_NAME_MAP, sdkMethod)) {
        throw new Error(
          `SDK namespace method '${ns}.${method}' needs '${sdkMethod}' in SDK_TOOL_NAME_MAP`,
        );
      }
    }
  }
}

/** A tool's structured payload as a namespace returns it: throws on a refusal, else drops `success`. */
export function unwrapToolPayload(label: string, payload: unknown, tool = label): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const { success, ...rest } = payload as Record<string, unknown>;
  if (success === false) {
    const reason = typeof rest.message === "string" ? rest.message : "tool refused the call";
    throw new SwarmToolError(`${label} failed: ${reason}`, { code: "refused", tool });
  }
  return rest;
}
