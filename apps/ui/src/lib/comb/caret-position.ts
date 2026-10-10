// Where a text position sits inside a textarea, in viewport coordinates, so a
// popover can open at the caret (the mention picker). The mirror-div
// technique: a hidden div copies the textarea's box and text styles, holds the
// text before the position, and a span marks the position.

const MIRRORED_PROPERTIES = [
  "direction",
  "boxSizing",
  "width",
  "overflowX",
  "overflowY",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontFamily",
  "lineHeight",
  "textAlign",
  "textTransform",
  "textIndent",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
] as const;

/** The caret box at `position`, relative to the textarea's border box (no scroll applied). */
export function caretOffset(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number; height: number } {
  const doc = textarea.ownerDocument;
  const computed = doc.defaultView?.getComputedStyle(textarea);
  const mirror = doc.createElement("div");
  const style = mirror.style;
  if (computed) for (const property of MIRRORED_PROPERTIES) style[property] = computed[property];
  style.position = "absolute";
  style.visibility = "hidden";
  style.top = "0";
  style.left = "-9999px";
  style.whiteSpace = "pre-wrap";
  style.overflowWrap = "break-word";
  // A scrollable textarea gives width to its scrollbar. The mirror keeps a
  // scrollbar too, so its lines wrap at the same place.
  style.overflowX = "hidden";
  style.overflowY = textarea.scrollHeight > textarea.clientHeight ? "scroll" : "hidden";
  style.height = "auto";

  mirror.textContent = textarea.value.slice(0, position);
  const marker = doc.createElement("span");
  // Text after the position keeps the line wrapping the same as in the textarea.
  marker.textContent = textarea.value.slice(position) || ".";
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);

  const fontSize = Number.parseFloat(computed?.fontSize ?? "") || 14;
  const lineHeight = Number.parseFloat(computed?.lineHeight ?? "") || fontSize * 1.4;
  const offset = {
    top: marker.offsetTop + (Number.parseFloat(computed?.borderTopWidth ?? "") || 0),
    left: marker.offsetLeft + (Number.parseFloat(computed?.borderLeftWidth ?? "") || 0),
    height: lineHeight,
  };
  mirror.remove();
  return offset;
}

/** The caret box at `position` in viewport coordinates (the textarea's scroll applied). */
export function caretClientRect(textarea: HTMLTextAreaElement, position: number): DOMRect {
  const box = textarea.getBoundingClientRect();
  const { top, left, height } = caretOffset(textarea, position);
  return new DOMRect(
    box.left + left - textarea.scrollLeft,
    box.top + top - textarea.scrollTop,
    0,
    height,
  );
}
