/**
 * The app `<main>` padding (`root-layout.tsx`). A page that runs to the edges
 * of `<main>` (the task page's scrollers) bleeds out of it with the negative
 * margins, and pads its content back with `MAIN_GUTTER_X`. Literal class
 * strings, so Tailwind's scanner sees them.
 */
export const MAIN_GUTTER = "p-4 md:p-6";
export const MAIN_GUTTER_X = "px-4 md:px-6";
export const MAIN_BLEED = "-m-4 md:-m-6";
export const MAIN_BLEED_Y = "-my-4 md:-my-6";
