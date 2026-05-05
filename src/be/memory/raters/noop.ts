import type { MemoryRater, RatingEvent } from "./types";

/**
 * Default rater. Emits no events, makes no DB calls. Selected when
 * MEMORY_RATERS is unset or empty so the framework defaults to behaving
 * byte-identically to pre-rater builds.
 */
export class NoopRater implements MemoryRater {
  readonly name = "noop";

  async rate(): Promise<RatingEvent[]> {
    return [];
  }
}
