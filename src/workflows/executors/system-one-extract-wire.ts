import type { SystemOneExtractionConfig } from "./system-one-extraction";
import {
  cloudflareErrorCode,
  isRecord,
  SystemOneWireError,
  wireContractError,
} from "./system-one-wire";

/**
 * How one host's extraction request and response map onto the `system-one-extraction`
 * contract: Clairic's `{ model, state, fields, images?, reference_date? }` request and
 * `{ model, answers, truncated, usage }` body. A host with another shape supplies a
 * wire that builds its body and returns that shape, which
 * `validateSystemOneExtraction` then checks.
 */
export interface SystemOneExtractWire {
  /** Request body for one call. */
  buildRequest(config: SystemOneExtractionConfig, model: string | undefined): unknown;
  /**
   * Turn a parsed success body into the Clairic `{ model, answers, usage }` shape, or
   * throw a `SystemOneWireError`. The result is still validated afterwards.
   */
  toExtraction(body: unknown): unknown;
}

/** Clairic reads one text; structured state is sent as JSON text, which spans then index into. */
export function extractionStateText(state: SystemOneExtractionConfig["state"]): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

/** The Clairic request as is: field specs already use Clairic's option names. */
export const CLAIRIC_WIRE: SystemOneExtractWire = {
  buildRequest: (config, model) => ({
    ...(model === undefined ? {} : { model }),
    state: extractionStateText(config.state),
    fields: config.fields,
    ...(config.images?.length ? { images: config.images } : {}),
    ...(config.referenceDate ? { reference_date: config.referenceDate } : {}),
  }),
  toExtraction: (body) => body,
};

/** Cloudflare Workers AI: the Clairic request, the response wrapped in `{ result, success, errors }`. */
export const CLOUDFLARE_EXTRACT_WIRE: SystemOneExtractWire = {
  buildRequest: CLAIRIC_WIRE.buildRequest,
  toExtraction(body) {
    if (!isRecord(body)) wireContractError("response body must be a JSON object");
    if (body.success !== true) {
      const code = cloudflareErrorCode(body);
      throw new SystemOneWireError(
        `Cloudflare Workers AI reported a failed run${code ? ` (${code})` : ""}. Nothing was extracted.`,
      );
    }
    if (!isRecord(body.result)) wireContractError("Cloudflare response is missing its result");
    return body.result;
  },
};
