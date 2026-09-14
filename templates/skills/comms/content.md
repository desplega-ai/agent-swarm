# /comms — make it land

Merged from three MIT sources: [bro-skill](https://github.com/luchasarie/bro-skill) (Simpler), the local show-me skill (Visual), and [asd-ste100-skill](https://github.com/desplega-ai/asd-ste100-skill) (Precise).

One skill, three base modes plus a joint one. Pick from the **target** of the request, not from the wording alone.

## Dispatch

| Target of the request | Mode |
|---|---|
| Your own previous message — "simpler", "bro what", "didn't get it", "rephrase" | **Simpler** |
| A concept, flow, architecture, or change — "show me", "draw", "diagram", "what does this look like" | **Visual** |
| Your previous message AND it describes structure (a flow, a tree, an architecture, a sequence) — or the user asks for both ("simpler, and draw it") | **Joint** |
| Artifact text a machine or reader must parse without a back-channel — tool description, error message, prompt, doc paragraph — "disambiguate", "rewrite", "STE" | **Precise** |

Dispatch rules:

- If the request names a mode, obey it.
- If the target is your previous message and it is plain prose, use Simpler. If it describes structure, prefer Joint — a small visual usually lands faster than more words.
- Never mix registers: no casual flavor in Precise output, no STE flatness in Simpler output. Precise never combines with the other modes.
- If there is nothing to re-express (no previous message, no artifact, no topic), say so in one line.

## Mode: Simpler

Re-explain YOUR most recent assistant message like you're explaining it to a smart friend over a beer.

1. **Re-explain, don't re-answer.** Never answer a new question, never add new information, never use tools. You are only re-expressing what you already said.
2. **Simpler, not necessarily shorter.** The goal is "impossible to misunderstand", not "fewer words". Cut preamble, hedging, and consultant-speak — keep whatever length real clarity needs.
3. **Facts survive verbatim.** Every path, command, filename, number, URL, name, and decision stays EXACTLY as it was. Simplify the explanation around the facts, never the facts themselves.
4. **Light casual flavor.** Direct and informal ("basically...", "the point is...", "ok so..."). A touch of personality — don't turn it into a meme.
5. **Same language.** If the original message was in another language, the simpler version stays in that language.
6. **Flatten structure.** Drop headers and ceremony. Tables become plain sentences. Keep a short list only if the original genuinely had multiple parts.

## Mode: Visual

Help the user understand the current topic visually. Skip the preamble and keep prose brief. Pick the smallest view that makes the key point clear:

- **Pseudocode** for logic or an algorithm.
- **Call tree** for runtime control flow.
- **Component tree** for UI structure, including the state and module boundaries that matter.
- **Shallow file tree** for file responsibility or a broad refactor.
- **Mermaid** for component interaction, control flow, or data flow.
- **`diff`** when the point is what changes and the surrounding shape already exists — diff the tree or pseudocode itself, not raw code. Match the diff shape to the topic.
- **Whole code block** when most of it is new, when omitted context would hide ownership or order, or when the user needs a copyable target shape.
- **One focused HTML file** for a visual UI, layout, state comparison, or concept too dense for Mermaid — a diagram, infographic, or short slide deck. Match the product's colors, type, spacing, and components; use real labels and data; support desktop and mobile. Then `Bash(open path/to/comms-{description}.html)`.

Place each visual next to the short text it supports. Keep only the calls, files, props, states, and boundaries needed to answer the current question. Use one shape, maybe several — never all. Concrete example shapes: `references/visual-shapes.md`.

**Delivery:** write the visual explanation to `/tmp/YYYY-MM-DD-HHMM-comms-<topic>.md` and open it with `file-review` (via Bash, `run_in_background: true`, `timeout: 600000`) — it rich-renders the markdown and lets the user leave inline comments; process their comments when the window closes. If `file-review` is not on PATH, put the visual in chat instead. Keep `Bash(open ...)` for HTML artifacts. Skip file-review only for a single small visual that reads fine in chat.

## Mode: Joint

Simpler + Visual in one document: Simpler-mode prose with Visual-mode shapes placed right after the sentence each one supports. Follow both rule sets — casual register for the words, smallest-view discipline for the visuals. Deliver via file-review, like Visual mode.

## Mode: Precise

Rewrite the given text under ASD-STE100 structural discipline so no reader — human or agent — can misparse it. Full rule tables, sub-mode detail, and process: `references/ste-rules.md`.

Core rules:

- Active voice. Simple tenses ("we received", not "we have received").
- One instruction per sentence. ≤20 words for instructions, ≤25 for descriptions.
- No semicolons. No phrasal verbs ("start", not "spin up"). No noun stacks over 3 words. No dropped words.
- One name per thing — never rotate synonyms for the same referent.
- Verb over nominalization ("analyze the log", not "perform an analysis of the log").
- **Keep every hedge and qualifier.** "May have failed" never becomes "failed". A rewrite that changes confidence is a different claim, not a simplification.
- Never add a fact the source did not state.

Two sub-modes:

- **Strict** — tool descriptions, error messages, prompts, procedures, safety text: every rule.
- **STE-flavored** — READMEs, PR text, explanatory prose: structural rules in full, lexical rules advisory.

Output: the rewritten text and nothing else — no preamble, no mode announcement, no change summary. If you deliberately kept a longer phrasing to preserve precision, add one line prefixed `Kept as-is:`. When asked to "show the diff" or "explain the changes", output the before/after rule table from `references/ste-rules.md` instead.
