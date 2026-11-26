/**
 * A synthetic task corpus for the task search benchmark (bench/task-search.ts).
 * Deterministic: the same size and seed give the same rows on every run.
 *
 * Text lengths follow a log-normal distribution with a median of 2,300
 * characters, a p95 near 54,000 and a mean near 14,500, cut at 511,000: the
 * shape of a large swarm database, where a few tasks carry whole logs or
 * diffs. The words follow a Zipf distribution over a vocabulary that starts
 * with common English and engineering words, so a word such as "review" is in
 * about half of the tasks, and a long text holds almost every common word.
 */

export type TaskCorpusRow = {
  id: string;
  task: string;
  title: string | null;
  status: string;
  taskType: string | null;
  tags: string;
  priority: number;
  createdAt: string;
  lastUpdatedAt: string;
};

/** The query words of a corpus, without its rows. */
export type TaskCorpusWords = {
  words: string[];
  /** The three common words that some tasks hold side by side. */
  phrase: string;
  /** A word of the tail that about 0.1% of the tasks hold. */
  rareWord: string;
};

const HEAD_WORDS = `
the to and a of in is for on with this that it be from as at by an not or are we if task
agent file code run fix test error add use can should new when will all review check has
request do pr branch update change data need one after pull make then into time but output
api build user issue commit start more only no done step line result value memory type
path slack main search server message list name set log get call config status first query
work worker script read write open close page table event model send plan report context
found keep each other also same next before local image docker deploy release version
merge comment thread channel schedule workflow session prompt token index migration schema
column row key secret auth login browser screen button form field layout style theme color
postgres sqlite database cache queue retry timeout limit batch
`
  .trim()
  .split(/\s+/);

const VOCABULARY_TAIL = 30_000;
const SAMPLE_TABLE_BITS = 22;

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

/** Generated tail words: syllables that no English word list holds. */
function tailWords(random: () => number, taken: Set<string>): string[] {
  const consonants = "bdfgklmnprstvz";
  const vowels = "aeiou";
  const words: string[] = [];
  while (words.length < VOCABULARY_TAIL) {
    const syllables = 2 + Math.floor(random() * 3);
    let word = "";
    for (let s = 0; s < syllables; s++) {
      word += consonants[Math.floor(random() * consonants.length)];
      word += vowels[Math.floor(random() * vowels.length)];
    }
    word += consonants[Math.floor(random() * consonants.length)];
    if (taken.has(word)) continue;
    taken.add(word);
    words.push(word);
  }
  return words;
}

/** A lookup table from a uniform draw to a Zipf rank (exponent 1). */
function zipfSampler(size: number, random: () => number): () => number {
  const cumulative = new Float64Array(size);
  let sum = 0;
  for (let rank = 0; rank < size; rank++) {
    sum += 1 / (rank + 1);
    cumulative[rank] = sum;
  }
  const slots = 1 << SAMPLE_TABLE_BITS;
  const table = new Uint32Array(slots);
  let rank = 0;
  for (let slot = 0; slot < slots; slot++) {
    const target = ((slot + 0.5) / slots) * sum;
    while ((cumulative[rank] as number) < target) rank++;
    table[slot] = rank;
  }
  return () => table[(random() * slots) | 0] as number;
}

/** A standard normal draw (Box-Muller). */
function normal(random: () => number): number {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A text length: log-normal, median 2,300, p95 near 54,000, at most 511,000. */
function textLength(random: () => number): number {
  const length = Math.exp(Math.log(2_300) + 1.915 * normal(random));
  return Math.max(40, Math.min(511_000, Math.round(length)));
}

/** A UUID-shaped id from the seeded generator. */
function uuid(random: () => number): string {
  let hex = "";
  for (let i = 0; i < 32; i++) hex += Math.floor(random() * 16).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

const STATUSES = ["completed", "completed", "completed", "failed", "cancelled", "in_progress"];
const START_MS = Date.parse("2026-06-01T00:00:00.000Z");
const SPAN_MS = 170 * 24 * 3600 * 1000;

function vocabularyOf(random: () => number): TaskCorpusWords {
  const taken = new Set(HEAD_WORDS);
  const words = [...HEAD_WORDS, ...tailWords(random, taken)];
  // Rank 28,000 of 30,000: in well under 1% of the tasks.
  const rareWord = words[HEAD_WORDS.length + 28_000] as string;
  return { words, phrase: "review pull request", rareWord };
}

export function taskCorpusWords(seed = 11): TaskCorpusWords {
  return vocabularyOf(generator(seed));
}

/** The rows of a corpus, in insertion order. */
export function* taskCorpusRows(size: number, seed = 11): Generator<TaskCorpusRow> {
  const random = generator(seed);
  const { words, phrase } = vocabularyOf(random);
  const sample = zipfSampler(words.length, random);
  const separators = [" ", " ", " ", " ", " ", " ", " ", ", ", ". ", "\n", " / ", " - ", ": "];
  for (let i = 0; i < size; i++) {
    const wanted = textLength(random);
    const parts: string[] = [];
    let length = 0;
    const phraseAt = random() < 0.05 ? Math.floor(random() * 40) : -1;
    while (length < wanted) {
      const word = parts.length === phraseAt * 2 ? phrase : (words[sample()] as string);
      const separator = separators[Math.floor(random() * separators.length)] as string;
      parts.push(word, separator);
      length += word.length + separator.length;
    }
    const task = parts.join("").slice(0, wanted).trim();
    let title: string | null = null;
    if (random() < 0.7) {
      const titleWords: string[] = [];
      const count = 3 + Math.floor(random() * 6);
      for (let w = 0; w < count; w++) titleWords.push(words[sample()] as string);
      title = titleWords.join(" ");
    }
    const createdMs = START_MS + Math.floor((i / size) * SPAN_MS);
    const updatedMs = createdMs + Math.floor(random() * 6 * 3600 * 1000);
    const heartbeat = random() < 0.03;
    yield {
      id: uuid(random),
      task,
      title,
      status: STATUSES[Math.floor(random() * STATUSES.length)] as string,
      taskType: heartbeat ? "heartbeat" : random() < 0.5 ? "task" : null,
      tags: heartbeat ? '["heartbeat"]' : random() < 0.2 ? '["github"]' : "[]",
      priority: random() < 0.8 ? 50 : Math.floor(random() * 100),
      createdAt: new Date(createdMs).toISOString(),
      lastUpdatedAt: new Date(updatedMs).toISOString(),
    };
  }
}
