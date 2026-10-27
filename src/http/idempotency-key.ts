import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  findAcceptedWorkflowOperation,
  type WorkflowIdempotencyClaim,
} from "../be/db/workflow-idempotency";
import { getRequestAuth } from "../utils/request-auth-context";
import { jsonError } from "./utils";

/** Visible ASCII, at most 255 characters: room for a UUID, a ULID or a client's own scheme. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

/** Set on a response answered from an earlier accepted request. */
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

/** OpenAPI declaration of the optional `Idempotency-Key` request header. */
export const idempotencyKeyHeader = (accepted: string) =>
  z.object({
    "Idempotency-Key": z
      .string()
      .regex(IDEMPOTENCY_KEY_PATTERN)
      .optional()
      .describe(
        "Optional client-generated key, 1-255 visible ASCII characters (a UUID works). " +
          `The first request the server accepts under a key ${accepted}; a retry with the same key ` +
          "and an equivalent body gets that request's status and body back (with " +
          `\`${IDEMPOTENT_REPLAYED_HEADER}: true\`) and changes nothing. The key is scoped to the ` +
          "caller's identity and this operation; it is not a credential. The same key with a " +
          "different body is a 409. A request rejected before it is accepted (validation, auth, " +
          "not found, disabled) does not use up the key. Accepted keys do not expire.",
      ),
  });

/** A request that sent a usable `Idempotency-Key`. */
export interface IdempotencyKeyRequest {
  /** Stable identity of the authenticated caller, never a credential value. */
  principal: string;
  key: string;
}

/**
 * The caller identity a key is scoped to. A user or session token names its
 * user or agent; rotating the token keeps the scope. Requests on the swarm API
 * key are the operator, or the agent named by X-Agent-ID: every worker shares
 * that key, so this keeps their keys apart (it is not an access boundary; the
 * swarm key may act as any agent). A guest page session has no identity.
 */
function idempotencyPrincipal(req: IncomingMessage, myAgentId: string | undefined): string | null {
  const auth = getRequestAuth(req);
  switch (auth?.kind) {
    case "user":
      return `user:${auth.userId}`;
    case "agent":
      return `agent:${auth.agentId}`;
    case "controller":
      return `controller:${auth.controllerId}`;
    case "guest":
      return null;
    default:
      return myAgentId ? `agent:${myAgentId}` : "operator";
  }
}

/**
 * Read the `Idempotency-Key` header. Undefined when none was sent; null when
 * it is malformed or the caller has no identity to scope it to, after writing
 * the 400.
 */
export function readIdempotencyKey(
  req: IncomingMessage,
  res: ServerResponse,
  myAgentId: string | undefined,
): IdempotencyKeyRequest | null | undefined {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return undefined;
  const key = Array.isArray(raw) ? raw.join(", ") : raw;
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    jsonError(res, "Idempotency-Key must be 1-255 visible ASCII characters", 400);
    return null;
  }
  const principal = idempotencyPrincipal(req, myAgentId);
  if (!principal) {
    jsonError(res, "Idempotency-Key needs an identified caller", 400);
    return null;
  }
  return { principal, key };
}

/**
 * Answer from the operation already accepted under this claim's scope, if
 * any. Returns false, writing nothing, when there is none. Otherwise writes a
 * 409 when the stored request differs, a 410 when its workflow was deleted,
 * or hands the stored body to `send` with the replay header set, and returns
 * true. Runs after authentication and before any check that may have changed
 * since the original request.
 */
export async function replayAcceptedOperation(
  res: ServerResponse,
  claim: WorkflowIdempotencyClaim,
  send: (body: unknown) => void,
): Promise<boolean> {
  const accepted = await findAcceptedWorkflowOperation(claim);
  if (!accepted) return false;
  if (accepted.fingerprint !== claim.fingerprint) {
    jsonError(res, "Idempotency-Key was already used for a different request", 409);
  } else if (accepted.resourceDeletedAt !== null) {
    jsonError(
      res,
      "The workflow this Idempotency-Key created or triggered was deleted; send a new key to start over",
      410,
    );
  } else {
    res.setHeader(IDEMPOTENT_REPLAYED_HEADER, "true");
    send(accepted.body);
  }
  return true;
}
