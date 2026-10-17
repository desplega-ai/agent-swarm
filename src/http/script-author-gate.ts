import type { IncomingMessage, ServerResponse } from "node:http";
import { getWorkflow } from "../be/db";
import { userHasExplicitVerb } from "../be/rbac-roles";
import { can } from "../rbac";
import type { WorkflowDefinition } from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { requestPrincipal } from "./request-principal";
import { jsonError } from "./utils";

export const SCRIPT_AUTHOR_DENIED =
  "Forbidden: this user needs the script.author permission (grant it with the built-in script-author role)";

/**
 * Whether the request's own principal may author script code: run inline source, save a script,
 * launch a durable run, or expose a script as an API. Checked before X-Agent-ID is resolved, so
 * naming an agent never lends its rights to the caller.
 *
 * The operator key and agent tokens pass the legacy rule. A user passes only when one of their
 * roles lists `script.author` by name; the default admin role's grant-all does not count.
 */
export async function hasScriptAuthorRight(
  req: IncomingMessage,
  agentId: string | undefined,
): Promise<boolean> {
  const auth = getRequestAuth(req);
  if (auth?.kind === "user") {
    return await userHasExplicitVerb(auth.userId, "script.author");
  }
  const principal = await requestPrincipal(req, agentId);
  if (!principal) return false;
  return can({ principal, verb: "script.author", source: "http" }).allow;
}

const SCRIPT_NODE_TYPES = new Set(["script", "swarm-script"]);

/** Whether any object nested in `value` is a node-shaped `{ type: "script" | "swarm-script" }`. */
function containsScriptNode(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsScriptNode);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type === "string" && SCRIPT_NODE_TYPES.has(record.type)) return true;
  return Object.values(record).some(containsScriptNode);
}

/**
 * Whether running this definition can execute script code: a `script` or `swarm-script` node,
 * one nested in another node's config (a foreach body), or a `sub-workflow` node whose target
 * workflow does. A sub-workflow id that is a `{{token}}` cannot be resolved here, so it counts.
 */
export async function definitionDispatchesScript(
  definition: Pick<WorkflowDefinition, "nodes">,
  seen: Set<string> = new Set(),
): Promise<boolean> {
  if (containsScriptNode(definition.nodes)) return true;
  for (const node of definition.nodes) {
    if (node.type !== "sub-workflow") continue;
    const workflowId = node.config.workflowId;
    if (typeof workflowId !== "string") continue;
    if (workflowId.includes("{{")) return true;
    if (seen.has(workflowId)) continue;
    seen.add(workflowId);
    const child = await getWorkflow(workflowId);
    if (child && (await definitionDispatchesScript(child.definition, seen))) return true;
  }
  return false;
}

/** Writes a 403 and returns true when the caller may not author script code. */
export async function rejectWithoutScriptAuthor(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string | undefined,
): Promise<boolean> {
  if (await hasScriptAuthorRight(req, agentId)) return false;
  jsonError(res, SCRIPT_AUTHOR_DENIED, 403);
  return true;
}

/**
 * Writes a 403 and returns true when the caller may not author script code and `definition`
 * (a workflow being saved, triggered or retried) would run some.
 */
export async function rejectScriptDefinitionWithoutAuthor(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string | undefined,
  definition: Pick<WorkflowDefinition, "nodes">,
): Promise<boolean> {
  if (await hasScriptAuthorRight(req, agentId)) return false;
  if (!(await definitionDispatchesScript(definition))) return false;
  jsonError(res, SCRIPT_AUTHOR_DENIED, 403);
  return true;
}

/**
 * For saves whose final definition is only known inside a transaction (node patches): undefined
 * when the caller may author scripts, else a check that refuses a definition that runs script code.
 */
export async function scriptDefinitionRefusal(
  req: IncomingMessage,
  agentId: string | undefined,
): Promise<((definition: WorkflowDefinition) => Promise<string | null>) | undefined> {
  if (await hasScriptAuthorRight(req, agentId)) return undefined;
  return async (definition) =>
    (await definitionDispatchesScript(definition)) ? SCRIPT_AUTHOR_DENIED : null;
}
