/**
 * Touch targets for the task page's narrow layout.
 *
 * The page picks its layout by its own width: the page root is a Tailwind
 * `@container`, and under 60rem it shows the narrow tree (sticky tabs and a
 * bottom bar). There, page controls are at least 44 px tall. These classes
 * apply only under 60rem of page width, so a part that both trees render
 * (the details rail, the source line) keeps its desktop size in the wide one.
 */

/** A control that is already a block, flex or inline-flex box. */
export const NARROW_TARGET = "@max-[60rem]:min-h-11";

/** An inline control (a link in a value cell): it becomes an inline-flex box. */
export const NARROW_INLINE_TARGET =
  "@max-[60rem]:inline-flex @max-[60rem]:min-h-11 @max-[60rem]:items-center";

/** A square icon button. */
export const NARROW_ICON_TARGET = "@max-[60rem]:size-11";
