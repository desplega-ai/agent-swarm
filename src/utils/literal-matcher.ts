/**
 * Aho-Corasick search for a fixed set of ASCII literals, in one pass over the
 * text. A regex alternation of a few hundred literals costs about 30 ns per
 * character in JSC; this automaton costs a few ns.
 *
 * Matching is ASCII case-insensitive and exact otherwise: a character outside
 * ASCII matches no pattern, which is what a `/i` regex does for ASCII
 * patterns. With `skip`, those characters are ignored in the text (a text
 * `to-ken` then matches `token`), so a hit is a superset of the exact match.
 */
export interface LiteralMatcherOptions {
  /** Text characters to ignore. A pattern must not contain one. */
  skip?: string;
}

export class LiteralMatcher {
  readonly classes = new Uint8Array(128);
  readonly width: number;
  readonly next: Int32Array;
  /** Pattern ids ending at a state, fail links included. */
  readonly outputs: Array<number[] | undefined>;
  readonly skipped = new Uint8Array(128);
  readonly hasOutput: Uint8Array;

  constructor(patterns: readonly string[], opts: LiteralMatcherOptions = {}) {
    for (const ch of opts.skip ?? "") this.skipped[ch.charCodeAt(0)] = 1;
    // Class 0 is "any other character"; each distinct pattern character gets one.
    let classCount = 1;
    const fold = (code: number) => (code >= 65 && code <= 90 ? code + 32 : code);
    for (const pattern of patterns) {
      for (let i = 0; i < pattern.length; i++) {
        const code = fold(pattern.charCodeAt(i));
        if (code >= 128 || this.skipped[code]) throw new Error(`unsupported pattern: ${pattern}`);
        if (this.classes[code] === 0) this.classes[code] = classCount++;
      }
    }
    for (let code = 65; code <= 90; code++) this.classes[code] = this.classes[code + 32] as number;
    this.width = classCount;

    // Trie, then failure links breadth-first, then a dense transition table.
    const children: Array<Map<number, number>> = [new Map()];
    const outputs: Array<number[] | undefined> = [undefined];
    patterns.forEach((pattern, id) => {
      let state = 0;
      for (let i = 0; i < pattern.length; i++) {
        const cls = this.classes[pattern.charCodeAt(i)] as number;
        let child = children[state]?.get(cls);
        if (child === undefined) {
          child = children.length;
          children.push(new Map());
          outputs.push(undefined);
          children[state]?.set(cls, child);
        }
        state = child;
      }
      outputs[state] = [...(outputs[state] ?? []), id];
    });
    const next = new Int32Array(children.length * classCount);
    const fail = new Int32Array(children.length);
    const queue: number[] = [];
    for (const [cls, child] of children[0] ?? []) {
      next[cls] = child;
      queue.push(child);
    }
    for (let head = 0; head < queue.length; head++) {
      const state = queue[head] as number;
      const failState = fail[state] as number;
      const inherited = outputs[failState];
      if (inherited) outputs[state] = [...(outputs[state] ?? []), ...inherited];
      for (let cls = 0; cls < classCount; cls++) {
        const child = children[state]?.get(cls);
        if (child === undefined) {
          next[state * classCount + cls] = next[failState * classCount + cls] as number;
        } else {
          fail[child] = next[failState * classCount + cls] as number;
          next[state * classCount + cls] = child;
          queue.push(child);
        }
      }
    }
    this.next = next;
    this.outputs = outputs;
    this.hasOutput = Uint8Array.from(outputs, (out) => (out ? 1 : 0));
  }

  /** True when any pattern occurs in `text`. Stops at the first. */
  has(text: string): boolean {
    const { classes, skipped, next, hasOutput, width } = this;
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 128) {
        state = 0;
        continue;
      }
      if (skipped[code]) continue;
      state = next[state * width + (classes[code] as number)] as number;
      if (hasOutput[state]) return true;
    }
    return false;
  }

  /** Sets `found[id] = 1` for every pattern that occurs in `text`. */
  collect(text: string, found: Uint8Array): void {
    const { classes, skipped, next, hasOutput, outputs, width } = this;
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 128) {
        state = 0;
        continue;
      }
      if (skipped[code]) continue;
      state = next[state * width + (classes[code] as number)] as number;
      if (hasOutput[state]) for (const id of outputs[state] as number[]) found[id] = 1;
    }
  }
}
