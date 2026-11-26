/**
 * A synthetic memory corpus for the full-text benchmark (bench/memory-fts.ts).
 * Deterministic: the same size and seed give the same rows on every run.
 *
 * Words follow a Zipf distribution over a generated vocabulary, so a few words
 * are in almost every memory, a band of words is in 10% to 60% of them, and
 * the tail is rare. Each word ends in "a" or "o": no English suffix rule of
 * the Porter (SQLite) or Snowball (Postgres) stemmer applies, so both engines
 * index the same lexemes and the parity check compares ranking, not stemming.
 */

export type CorpusRow = {
  id: string;
  agentId: string;
  scope: "agent" | "swarm";
  name: string;
  content: string;
};

export type Corpus = {
  rows: CorpusRow[];
  vocabulary: string[];
  /** The two words of the phrase that some memories hold side by side. */
  phrase: [string, string];
};

const VOCABULARY_SIZE = 30_000;
const AGENTS = 20;

/** mulberry32: a small seeded generator. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vocabulary(random: () => number): string[] {
  const consonants = "bdfgklmnprstvz";
  const vowels = "aeiou";
  const words = new Set<string>();
  while (words.size < VOCABULARY_SIZE) {
    const syllables = 2 + Math.floor(random() * 3);
    let word = "";
    for (let s = 0; s < syllables - 1; s++) {
      word += consonants[Math.floor(random() * consonants.length)];
      word += vowels[Math.floor(random() * vowels.length)];
    }
    word += consonants[Math.floor(random() * consonants.length)];
    word += random() < 0.5 ? "a" : "o";
    words.add(word);
  }
  return [...words];
}

/** Cumulative Zipf weights (exponent 1) for sampling a word rank. */
function zipfTable(size: number): Float64Array {
  const table = new Float64Array(size);
  let sum = 0;
  for (let rank = 0; rank < size; rank++) {
    sum += 1 / (rank + 1);
    table[rank] = sum;
  }
  for (let rank = 0; rank < size; rank++) table[rank] = (table[rank] as number) / sum;
  return table;
}

function sampleRank(table: Float64Array, random: () => number): number {
  const target = random();
  let low = 0;
  let high = table.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((table[mid] as number) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** A content length: about 1,300 characters on average, a long tail up to 16,800. */
function contentLength(random: () => number): number {
  if (random() < 0.003) return 6_000 + Math.floor(random() * 10_000);
  // Sum of uniforms: a bell around 1,250 with p95 near 2,050.
  const bell = (random() + random() + random() + random()) / 4;
  return Math.round(250 + bell * 1_800);
}

export function buildCorpus(size: number, seed = 7): Corpus {
  const random = generator(seed);
  const words = vocabulary(random);
  const table = zipfTable(words.length);
  const phrase: [string, string] = [words[300] as string, words[420] as string];
  const punctuation = [" ", " ", " ", " ", " ", " ", ", ", ". ", " / ", " - ", ": "];
  const rows: CorpusRow[] = [];
  for (let i = 0; i < size; i++) {
    const wanted = contentLength(random);
    const parts: string[] = [];
    let length = 0;
    const withPhrase = random() < 0.04;
    while (length < wanted) {
      if (withPhrase && parts.length === 20) {
        parts.push(`${phrase[0]} ${phrase[1]}`);
      } else {
        parts.push(words[sampleRank(table, random)] as string);
      }
      parts.push(punctuation[Math.floor(random() * punctuation.length)] as string);
      length += (parts[parts.length - 2] as string).length + 1;
    }
    const nameWords = 2 + Math.floor(random() * 4);
    const name: string[] = [];
    for (let w = 0; w < nameWords; w++) name.push(words[sampleRank(table, random)] as string);
    rows.push({
      id: `m-${String(i).padStart(6, "0")}`,
      agentId: `agent-${i % AGENTS}`,
      scope: random() < 0.7 ? "swarm" : "agent",
      name: name.join(" "),
      content: parts.join("").trim(),
    });
  }
  return { rows, vocabulary: words, phrase };
}

/** Lowercased word tokens of a row, the same split for both fields. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** For each word, the share of rows (0..1) that hold it in the name or the content. */
export function documentFrequencies(rows: CorpusRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const seen = new Set([...tokens(row.name), ...tokens(row.content)]);
    for (const word of seen) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const shares = new Map<string, number>();
  for (const [word, count] of counts) shares.set(word, count / rows.length);
  return shares;
}
