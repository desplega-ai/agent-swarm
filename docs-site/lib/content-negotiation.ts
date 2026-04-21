import Negotiator from "negotiator";

export const MEDIA_HTML = "text/html";
export const MEDIA_MARKDOWN = "text/markdown";
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

export const SUPPORTED_MEDIA_TYPES: readonly string[] = [MEDIA_HTML, MEDIA_MARKDOWN];

export type NegotiatedMedia = typeof MEDIA_HTML | typeof MEDIA_MARKDOWN;

export interface NegotiationResult {
  /** The chosen media type, or null when no supported type has q > 0. */
  chosen: NegotiatedMedia | null;
  /** True when the client sent no Accept header (default to HTML). */
  defaulted: boolean;
}

/**
 * Negotiate the response media type per RFC 9110 using the `negotiator` library.
 * Returns { chosen: null } when the client explicitly excludes every supported
 * type (e.g. `Accept: application/json`), signalling a 406 response.
 */
export function negotiateMedia(acceptHeader: string | null | undefined): NegotiationResult {
  if (!acceptHeader || acceptHeader.trim() === "") {
    return { chosen: MEDIA_HTML, defaulted: true };
  }

  const negotiator = new Negotiator({ headers: { accept: acceptHeader } });
  const chosen = negotiator.mediaType([...SUPPORTED_MEDIA_TYPES]);

  if (chosen === MEDIA_HTML || chosen === MEDIA_MARKDOWN) {
    return { chosen, defaulted: false };
  }

  return { chosen: null, defaulted: false };
}
