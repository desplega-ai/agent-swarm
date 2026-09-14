# Precise mode — ASD-STE100 rules

Condensed from [asd-ste100-skill](https://github.com/desplega-ai/asd-ste100-skill) (MIT), which encodes the rule categories of ASD-STE100 Issue 9 (Jan 2025).

This encodes the standard's rule *categories*, not ASD's ~900-word approved dictionary (free to obtain, not free to redistribute). Structural rules are checkable from the description alone — apply them with confidence. Lexical rules depend on the dictionary — apply them as a direction of travel, and never imply dictionary compliance.

## Structural rules — apply these

| Rule | Do | Don't |
|---|---|---|
| Active voice | "The agent deletes the file." | "The file is deleted (by the agent)." — unless the actor is genuinely unknown or irrelevant |
| No phrasal verbs | "Remove the panel." / "Start the job." | "Take off the panel." / "Spin up the job." |
| One instruction per sentence | "Open the file. Read line 3." | "Open the file and read line 3, then check if it matches." |
| Sentence length | ≤20 words for instructions, ≤25 for descriptions | Long compound/subordinate-clause sentences |
| No semicolons | Split into separate sentences | Any semicolon at all |
| Noun clusters | ≤3 words stacked as a noun phrase | 4+ word noun stacks ("high pressure fuel pump inlet valve assembly") |
| No ellipsis | Keep subject, verb, and article explicit | Drop words to save space ("Files not backed up will be lost" → ambiguous which files) |
| Keep modality | "The request **may have** failed." stays "may have" | Promote a hedge to a fact, or invent a certainty the source did not state |
| Paragraph limits | One topic per paragraph, ≤6 sentences | Multi-topic paragraphs |
| Lists for sequences | Numbered/bulleted list for 3+ steps or conditions | A sequence buried in one prose sentence |

## Lexical rules — direction of travel only

| Rule | Do | Don't |
|---|---|---|
| One word, one meaning | Pick one verb for one action and reuse it every time | Rotate synonyms ("check"/"verify"/"confirm") for the same action |
| One part of speech per word | "Apply oil to the valve" (oil = noun) | "Oil the valve" (oil = verb) |
| Verb, not noun | "Analyze the log." | "Perform an analysis of the log." |
| Domain terms | Keep needed technical terms; define each once if not common English | Jargon never defined |

## Simple tenses — one exception

STE permits infinitive, imperative, simple present, simple past, simple future, and past participle as adjective. It excludes present perfect: "we received the report", not "we have received the report". Exception: where the compound form carries information the simple form cannot — current relevance ("the job has completed" = output available now), or a hedge like "may have failed" — keep it and flag the departure.

## Scan checklist

Scan for all six before rewriting. Each is mechanical — you can point at the exact word that breaks it.

1. **Synonym rotation** — the same thing has several names ("the user", "the customer", "the client"). Fix: one name, every time.
2. **Hedge stacking** — qualifiers pile up until nothing is asserted ("it is important to note that this may potentially help to improve"). Fix: state the claim or delete it.
3. **Nominalization** — an action frozen into a noun ("perform an analysis of"). Fix: use the verb.
4. **Marketing adjectives** — seamless, robust, powerful, blazing-fast. Fix: delete, or replace with the measurement that earns the claim.
5. **Run-on sentences** — ideas joined by semicolons or em dashes. Fix: one idea per sentence.
6. **Soft phrasal verbs** — spin up, reach out, dive into, kick off. Fix: the single plain verb (start, contact, read, begin).

## Process

1. Pick the sub-mode (Strict or STE-flavored). Keep the choice internal unless asked.
2. Read the input once for meaning before rewriting anything.
3. Walk it sentence by sentence; flag every violation. In STE-flavored, flag lexical rules but do not enforce them.
4. Rewrite each flagged sentence, preserving the original meaning exactly. If a rewrite would drop necessary precision (a safety condition, scope qualifier, number), keep the longer phrasing and flag it. Check modality before committing — a shorter sentence that upgrades a hedge to a fact is a different claim. Never add a fact the source did not state.
5. Output the rewritten text alone. If the input already complies, say so — do not force changes.

## Diff table format (on request)

When asked to "show the diff" / "which rules did it break" / "before/after":

```markdown
| Rule violated | Original | Simplified |
|---|---|---|
| Present perfect tense | "We have received your request." | "We received your request." |
| Noun cluster (4+ words) | "the agent task queue priority handler" | "the handler that sets task-queue priority" |

Mode: Strict. 7 violations found.
```

Follow with one line naming anything deliberately not simplified, and why.

## Boundaries

- Not a certified STE authoring tool — a clarity tool inspired by the standard. For aerospace-grade compliance, check word-by-word against the official dictionary from [asd-ste100.org](https://www.asd-ste100.org/STE_downloads.html).
- Fixes form, not substance: a hollow paragraph rewritten under these rules is a clean hollow paragraph. Say so instead of polishing it.
- Stop when the sentence is unambiguous, not when it is shortest.
