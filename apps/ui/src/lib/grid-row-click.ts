/**
 * Clicks that must not open the row's detail page: links, buttons, switches,
 * and anywhere in the favorite column. The column guard matters because a
 * click on the star's cell padding, or on the star while it is disabled
 * (the browser then fires no click on the button), reaches the row with the
 * cell as its target.
 */
const NO_ROW_NAVIGATION = 'a, button, [data-slot="switch"], [col-id="favorite"]';

export function isRowNavigationSuppressed(target: EventTarget | null | undefined): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null | undefined;
  return typeof element?.closest === "function" && element.closest(NO_ROW_NAVIGATION) != null;
}
