import { stripSiblingBlock } from "../tasks/sibling-block";

const COMPLETED_INSTRUCTIONS =
  "\n\nIMPORTANT: Do NOT re-delegate or re-answer the original request. The worker has already handled it. Your job is ONLY to:\n1. Review the output above\n2. Do not relay the worker's raw output to Slack; the engine owns the thread tree and outcome card\n3. Complete this follow-up task\n\nUse";
const FAILED_INSTRUCTIONS = "\n\nDecide whether to reassign, retry, or handle the failure. Use";
const DETAILS_PREFIX = ' `get-task-details` with taskId "';
const DETAILS_SUFFIX = '" for full details.';

/** Shape only pre-task search text; never alter the task or persisted memory. */
export function buildRecallQuery(description: string): string {
  // Bound every parsing operation, while leaving room for wrapper boilerplate.
  let query = stripSiblingBlock(truncateUtf8(description, 65536));
  // Only the fixed header uses a regex; content is parsed with linear searches.
  const header = query.match(
    /^Worker task (completed|failed) — (?:review|action) needed\.\n\nAgent: [^\n]*\nOriginal task created by agent [^\n]*\nTask: "/,
  );
  if (header) {
    const taskStart = header[0].length;
    const outputMarker = header[1] === "completed" ? '"\n\nOutput:\n' : '"\n\nFailure reason: ';
    const taskEnd = query.indexOf(outputMarker, taskStart);
    const outputStart = taskEnd + outputMarker.length;
    const instructions = header[1] === "completed" ? COMPLETED_INSTRUCTIONS : FAILED_INSTRUCTIONS;
    const outputEnd = query.indexOf(instructions + DETAILS_PREFIX, outputStart);
    const idStart = outputEnd + instructions.length + DETAILS_PREFIX.length;
    const idEnd = query.indexOf('"', idStart);
    if (
      taskEnd !== -1 &&
      outputEnd !== -1 &&
      idEnd !== -1 &&
      !query.slice(idStart, idEnd).includes("\n") &&
      query.startsWith(DETAILS_SUFFIX, idEnd)
    ) {
      const creatorInstructions = query.indexOf(
        "\nAdditional instructions from the task creator:\n",
        outputStart,
      );
      const contentEnd =
        creatorInstructions !== -1 && creatorInstructions < outputEnd
          ? creatorInstructions
          : outputEnd;
      const threadContext: string[] = [];
      let cursor = idEnd + DETAILS_SUFFIX.length;
      while (cursor < query.length) {
        const start = query.indexOf("<thread_context>", cursor);
        if (start === -1) break;
        const end = query.indexOf("</thread_context>", start);
        if (end === -1) break;
        cursor = end + "</thread_context>".length;
        threadContext.push(query.slice(start, cursor));
      }
      query = [
        query.slice(taskStart, taskEnd),
        query.slice(outputStart, contentEnd),
        ...threadContext,
      ].join("\n\n");
    }
  }
  query = query.trim();
  return truncateUtf8(query, 8191);
}

function truncateUtf8(query: string, maxBytes: number): string {
  // OpenAI embeddings accept 8192 tokens. A UTF-8 byte budget of 8191 is
  // conservative for the byte-level tokenizer, even for multilingual text.
  // Iterate code points so truncation cannot split a surrogate pair.
  let bytes = 0;
  let end = 0;
  for (const character of query) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return query.slice(0, end);
}
