import type { SystemOneQuestion } from "./system-one-decision";
import {
  isRecord,
  type SystemOneWire,
  SystemOneWireError,
  wireContractError,
} from "./system-one-wire";

/**
 * The OpenAI Decisions API (`POST /v1/decisions`, public beta) as a SystemOne host.
 *
 * Request: `{ model, input, questions: [...] }`. Questions are an array named by
 * the node's question ids: `noul` becomes `predicate`, `choice` lists `choices`,
 * `score` lists `levels`. Response: `answers` is an array in question order, each
 * echoing `name`; choice and score probabilities are arrays of `{ value, probability }`.
 * Both directions are translated here so the rest of the node sees SystemOne.
 */

type Entry = string | null | unknown[] | Record<string, unknown>;

/** A criterion as text: a string as is, structure as JSON, null as nothing. */
function entryText(entry: Entry | undefined): string | undefined {
  if (entry === undefined || entry === null) return undefined;
  return typeof entry === "string" ? entry : JSON.stringify(entry);
}

function openaiInput(state: unknown): unknown {
  if (typeof state === "string") return state;
  if (Array.isArray(state)) {
    return [
      {
        role: "user",
        content: state.map((text) => ({ type: "input_text", text: String(text) })),
      },
    ];
  }
  // The API reads text and images only, so structured state is sent as JSON text.
  return JSON.stringify(state);
}

function openaiQuestion(name: string, question: SystemOneQuestion): Record<string, unknown> {
  const instructions = entryText(question.instructions) ?? "";
  switch (question.type) {
    case "noul": {
      // A predicate has no true/false descriptions; they become part of the instructions.
      const whenTrue = entryText(question.criteria?.true);
      const whenFalse = entryText(question.criteria?.false);
      const parts = [instructions];
      if (whenTrue) parts.push(`True when: ${whenTrue}`);
      if (whenFalse) parts.push(`False when: ${whenFalse}`);
      return { type: "predicate", name, instructions: parts.join("\n\n") };
    }
    case "choice":
      return {
        type: "choice",
        name,
        instructions,
        choices: Object.entries(question.criteria).map(([value, entry]) => {
          const description = entryText(entry);
          return description === undefined ? { value } : { value, description };
        }),
      };
    case "score":
      return {
        type: "score",
        name,
        instructions,
        // `label` is required, so a level with no description is named by its index.
        levels: question.criteria.map((entry, index) => ({
          label: entryText(entry) ?? String(index),
        })),
      };
  }
}

/** `[{ value, probability }]` as `{ [value]: probability }`. Anything else is left for the validator. */
function probabilityMap(value: unknown, at: string): unknown {
  if (!Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const item of value) {
    if (!isRecord(item) || (typeof item.value !== "string" && typeof item.value !== "number")) {
      wireContractError(`${at} entries must carry a string or number value`);
    }
    const key = String(item.value);
    if (Object.hasOwn(out, key)) wireContractError(`${at} lists an option twice`);
    out[key] = item.probability;
  }
  return out;
}

function toSystemOneAnswer(id: string, question: SystemOneQuestion, raw: Record<string, unknown>) {
  const at = `answer "${id}".probabilities`;
  switch (raw.type) {
    case "predicate":
      return { type: "noul", noul: raw.probability };
    case "choice":
      return {
        type: "choice",
        choice: raw.choice,
        probabilities: probabilityMap(raw.probabilities, at),
        confidence: raw.confidence,
      };
    case "score":
      return {
        type: "score",
        score: raw.score,
        probabilities: probabilityMap(raw.probabilities, at),
        // OpenAI does not echo the levels; the legend is the node's own criteria.
        legend:
          question.type === "score"
            ? Object.fromEntries(question.criteria.map((entry, index) => [String(index), entry]))
            : undefined,
        confidence: raw.confidence,
      };
    default:
      // The validator reports the type mismatch against the declared question.
      return raw;
  }
}

export const OPENAI_DECISIONS_WIRE: SystemOneWire = {
  buildRequest: (config, model) => ({
    ...(model === undefined ? {} : { model }),
    input: openaiInput(config.state),
    questions: Object.entries(config.questions).map(([name, question]) =>
      openaiQuestion(name, question),
    ),
  }),

  toSystemOne(body, { questions }) {
    if (!isRecord(body)) wireContractError("response body must be a JSON object");
    if (!Array.isArray(body.answers)) wireContractError("response is missing the answers array");

    const byName = new Map<string, Record<string, unknown>>();
    for (const answer of body.answers) {
      if (!isRecord(answer) || typeof answer.name !== "string") {
        wireContractError("every answer must be an object naming its question");
      }
      if (!Object.hasOwn(questions, answer.name)) {
        wireContractError("response contains an answer for an undeclared question");
      }
      if (byName.has(answer.name)) {
        wireContractError(`response answers question "${answer.name}" twice`);
      }
      byName.set(answer.name, answer);
    }

    // A refusal is not an answer of the declared type, so no decision is made.
    const refused = [...byName.values()]
      .filter((answer) => answer.type === "refusal")
      .map((answer) => `"${answer.name}"`);
    if (refused.length > 0) {
      throw new SystemOneWireError(
        `OpenAI refused question${refused.length > 1 ? "s" : ""} ${refused.join(", ")}; no decision was made`,
      );
    }

    const answers: Record<string, unknown> = {};
    for (const [id, answer] of byName) {
      const question = questions[id];
      if (question) answers[id] = toSystemOneAnswer(id, question, answer);
    }
    const usage = isRecord(body.usage)
      ? { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens }
      : body.usage;
    return { model: body.model, answers, usage };
  },
};
