# Dashboard motion

Moved from `apps/ui/CLAUDE.md`, which keeps the rule that causes damage when missed and a pointer here. Paths are relative to `apps/ui/` unless a line says repo root.

<!-- Applies when you are adding animation, transitions, easing, or an animated icon in ui. -->

Doctrine lives in [DESIGN.md § Motion](../DESIGN.md), read it first. Hard points: <300ms budget, exits faster than enters, `ease-swift`/`ease-snappy` tokens (never `ease-in`), transform/opacity only, no animation on keyboard-driven or high-frequency interactions, `MotionConfig reducedMotion="user"` is already mounted in `app/providers.tsx`.

Standard timings (all `ease-snappy` unless noted): Dialog/AlertDialog 200ms in / 150ms out; Popover/DropdownMenu/Select/Tooltip 150ms in / 100ms out; Sheet/Drawer 400/250 on `ease-swift` (the large-surface exception); collapse/reveal via the shared `AnimatedReveal` (`components/shared/animated-reveal.tsx`), 200/150 default (`CollapsibleSection`, settings rail), 150/120 `speed="fast"` for frequently-toggled surfaces like session-log expanders (click-driven toggles animate; data CHANGES never do); global sidebar rail width/left 200ms on `ease-swift` (the stock shadcn `ease-linear` is banned, no linear easing anywhere except shimmer loops). Keep Radix overlays on the shadcn CSS `animate-in/out` classes, do not rebase them onto motion/react.

`Button` transitions live in the un-layered `[data-slot="button"]` block in `globals.css`, NOT in Tailwind classes: colors follow linger timing while transform presses at 100ms and releases at 200ms. Don't re-add `transition-*` utilities to `button.tsx`; press scale is 0.98 (0.97 on sm/icon sizes, via the size variants). Sidebar nav rows don't press-scale (frequency rule).

Animated icons are vendored into `src/components/icons/`, sources in preference order: lucide-animated (`bunx shadcn@latest add "https://lucide-animated.com/r/<icon>.json"`, then move the file out of the literal `@/` directory the CLI creates), animateicons (`https://animateicons.in/r/lu-<icon>.json`) for gaps, hand-written on the same pattern (exact lucide path data) when neither ships one. Interactive-control and nav-row affordance only, never decorative, never in data rows (tables, logs, per-record lists). When the icon sits in a larger click target, drive it from the container via the `startAnimation`/`stopAnimation` handle ref (see `NavIconLink`). Icon variants must be transform-based: never animate `pathLength`/`opacity` from 0 (draw-ins blank the glyph on quick pass-overs; retune registry icons that ship one, see DESIGN.md § Motion "Animated icons").

Hover timing is asymmetric: pointer-hover surfaces enter instantly and release softly via the `.hover-linger` utility (timing-only; composes with the element's `transition-property`; never on keyboard-driven highlights or transform transitions, `Button` gets the same color timing through its own per-property block instead), see DESIGN.md § Motion "linger rule".
