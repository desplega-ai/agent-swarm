# Agent avatar full-library picker plan

1. Record the current UI build output as the bundle baseline.
2. Preserve the deterministic 30-icon fallback, adding a compatibility note and
   a focused regression test where practical.
3. Use the existing 64 choices as the empty-search shortlist; filter the
   expanded static catalog on normalized (space/hyphen-insensitive) text and
   cap results.
4. Keep every render synchronous through the static catalog, because measured
   dynamic imports produce an unacceptable number of output chunks.
5. Build, test, QA with the required four screenshots, commit/push incrementally,
   and open a fork-only PR with measured Plan A/B evidence.
