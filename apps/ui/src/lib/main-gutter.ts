/**
 * The app `<main>` padding (`root-layout.tsx`). No top padding: every page's
 * first row sits right under the app header, which is already tall enough to
 * frame it. A page that runs to the edges of `<main>` (the task page's
 * scrollers) bleeds out of it with the negative margins, and pads its content
 * back with `MAIN_GUTTER_X`. Literal class strings, so Tailwind's scanner sees
 * them.
 */
export const MAIN_GUTTER = "px-4 pb-4 md:px-6 md:pb-6";
export const MAIN_GUTTER_X = "px-4 md:px-6";
export const MAIN_BLEED = "-mx-4 -mb-4 md:-mx-6 md:-mb-6";
export const MAIN_BLEED_Y = "-mb-4 md:-mb-6";
