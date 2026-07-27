# Agent avatar Lucide discovery

`lucide-react@0.575.0` exposes `iconNames` and `DynamicIcon` from
`lucide-react/dynamic`. `iconNames` provides the complete 1,936-name discovery
surface without importing every SVG. The server only validates the stored icon
as kebab-case, so no backend contract or migration is involved.

The current static 64-icon catalog remains valuable as the no-query shortlist
and fast render path. The 30-entry `WORKER_ICONS` fallback pool (including its
order and modulus) is compatibility-sensitive and must remain unchanged.

Plan A was rejected after production builds: baseline was 182 files / 6,920,761
bytes; dynamic imports emitted 1,717 files / 7,889,424 bytes. Plan B's static
catalog approach measured 185 files / 7,015,043 bytes, so it adds only three
files without a lazy-chunk explosion.

**Round-3 update (curation pass):** the first Plan-B catalog shipped as an
alphabetical head-slice (331 additions, all starting a/b/c) and included 47
deprecated lucide-react aliases. It was replaced with a catalog curated across
the full a-z alphabet — 322 additions (386 icons total against the pinned
`lucide-react@0.575.0`, down from the earlier 395/400 estimates once zodiac
icons and other >0.575.0-only names were dropped and deprecated aliases were
scrubbed). Re-measured against the same acfdd810 baseline: the
`agent-avatar-*.js` chunk grew from 18,566 bytes (64-icon pre-search-feature
baseline) to 112,210 bytes raw — a **+93,640 byte (~91.4 KiB) delta**, gzip
7.46 kB -> 39.09 kB, or ~291 bytes/icon for the 322 new icons. Same order of
magnitude as the original Plan-B estimate; no lazy-chunk explosion.
