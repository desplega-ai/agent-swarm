import type { MemoryRater, RatingEvent } from "./types";

/**
 * Disabled rater. Emits no events, makes no DB calls. Selected when
 * MEMORY_RATERS is explicitly empty or no configured names are recognized.
 */
export class NoopRater implements MemoryRater {
  readonly name = "noop";

  async rate(): Promise<RatingEvent[]> {
    return [];
  }
}
