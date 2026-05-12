/**
 * Tiny semver comparator for the UI feature-gate hooks.
 *
 * Compares only the numeric `MAJOR.MINOR.PATCH` triplet — pre-release tags and
 * build metadata are ignored (stripped via the `-` / `+` separators).
 *
 * Returns:
 *   -1  if a <  b
 *    0  if a == b
 *    1  if a >  b
 *
 * Inputs that don't parse fall back to `0` for that segment so a comparison
 * still produces a deterministic result (avoids throwing in render).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parsed = (v: string): [number, number, number] => {
    // Strip pre-release / build metadata: "1.2.3-beta.1+build" → "1.2.3"
    const core = v.split(/[-+]/, 1)[0] ?? "";
    const parts = core.split(".");
    const num = (i: number): number => {
      const raw = parts[i];
      if (raw == null) return 0;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    };
    return [num(0), num(1), num(2)];
  };

  const [aMaj, aMin, aPatch] = parsed(a);
  const [bMaj, bMin, bPatch] = parsed(b);

  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}
