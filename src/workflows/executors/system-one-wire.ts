import type { SystemOneDecisionConfig, SystemOneQuestion } from "./system-one-decision";

/**
 * How one provider's request and response map onto the SystemOne contract. Most
 * hosts speak it natively (`SYSTEM_ONE_WIRE`). A host with another shape supplies
 * a wire that builds its body and turns its success body back into the SystemOne
 * shape, which `validateSystemOneResponse` then checks like any other.
 */
export interface SystemOneWire {
  /** Request body for one call. */
  buildRequest(config: SystemOneDecisionConfig, model: string | undefined): unknown;
  /**
   * Turn a parsed success body into the SystemOne `{ model, answers, usage }` shape,
   * or throw a `SystemOneWireError`. The result is still validated afterwards.
   */
  toSystemOne(body: unknown, call: SystemOneWireCall): unknown;
}

export interface SystemOneWireCall {
  questions: Record<string, SystemOneQuestion>;
  /** The model the request named, when one was sent. */
  model: string | undefined;
}

/**
 * A success body the wire cannot turn into a decision. `message` is the whole step
 * error: a shape problem carries the validation prefix, a refusal does not.
 */
export class SystemOneWireError extends Error {}

export const VALIDATION_PREFIX = "SystemOne response failed validation: ";

export function wireContractError(message: string): never {
  throw new SystemOneWireError(`${VALIDATION_PREFIX}${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The SystemOne request as is. The response needs no translation. */
export const SYSTEM_ONE_WIRE: SystemOneWire = {
  buildRequest: (config, model) => ({
    state: config.state,
    ...(model === undefined ? {} : { model }),
    questions: config.questions,
  }),
  toSystemOne: (body) => body,
};

/**
 * Cloudflare Workers AI. The request is the SystemOne request (Clef is SystemOne
 * compatible); the response is wrapped in Cloudflare's `{ result, success, errors }`
 * envelope.
 */
export const CLOUDFLARE_WIRE: SystemOneWire = {
  buildRequest: SYSTEM_ONE_WIRE.buildRequest,
  toSystemOne(body) {
    if (!isRecord(body)) wireContractError("response body must be a JSON object");
    if (body.success !== true) {
      const code = cloudflareErrorCode(body);
      throw new SystemOneWireError(
        `Cloudflare Workers AI reported a failed run${code ? ` (${code})` : ""}. No decision was made.`,
      );
    }
    if (!isRecord(body.result)) wireContractError("Cloudflare response is missing its result");
    return body.result;
  },
};

const ERROR_CODE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** `errors[0].code` of a Cloudflare envelope, a number or a short string, as text. */
export function cloudflareErrorCode(body: Record<string, unknown>): string | undefined {
  const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
  const code = isRecord(first) ? first.code : undefined;
  if (typeof code === "number" && Number.isSafeInteger(code)) return String(code);
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : undefined;
}
