// Comments on markdown assets (images, mermaid diagrams). agent-fs anchors a
// comment on text (a quote) and source lines, so a comment on an asset keeps
// the asset's source lines and no quote. The asset frame asks the comment
// layer for a composer with a DOM event, because the viewer and the comment
// rail are separate trees.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { NewCommentAnchor } from "./dom-text-space";

/** Fired on an asset frame (it bubbles) when the person asks to comment on it. */
export const ASSET_COMMENT_EVENT = "comb:asset-comment";

export interface AssetCommentDetail {
  /** What the composer names: "Image: Weekly traction", "Mermaid diagram". */
  label: string;
}

/**
 * The anchor of a comment on the asset `frame`: the source lines of the
 * nearest block that carries them (the image's paragraph, the diagram's
 * fence). Null when no block around it has lines.
 */
export function assetCommentAnchor(frame: Element): NewCommentAnchor | null {
  const block = frame.closest("[data-line-start]");
  const lineStart = Number(block?.getAttribute("data-line-start"));
  const lineEnd = Number(block?.getAttribute("data-line-end"));
  if (!Number.isInteger(lineStart) || lineStart < 1) return null;
  return {
    lineStart,
    lineEnd: Number.isInteger(lineEnd) && lineEnd >= lineStart ? lineEnd : lineStart,
    quotedContent: "",
  };
}
