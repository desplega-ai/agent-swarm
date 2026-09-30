import { stripSiblingBlock } from "../tasks/sibling-block";

/** Shape only pre-task search text; never alter the task or persisted memory. */
export function buildRecallQuery(description: string): string {
  let query = stripSiblingBlock(description);
  // Match the worker follow-up templates, including blank task/output fields.
  // Keep thread context appended outside the lifecycle wrapper.
  const wrapper = query.match(
    /^Worker task (completed|failed) — (?:review|action) needed\.\n\nAgent: [^\n]*\nOriginal task created by agent [^\n]*\nTask: "([\s\S]*?)"\n\n(?:Output:\n|Failure reason: )([\s\S]*?)(?:\nAdditional instructions from the task creator:\n[\s\S]*?)?(?:\n\nIMPORTANT: Do NOT re-delegate or re-answer the original request\. The worker has already handled it\. Your job is ONLY to:\n1\. Review the output above\n2\. Do not relay the worker's raw output to Slack; the engine owns the thread tree and outcome card\n3\. Complete this follow-up task\n\nUse|\n\nDecide whether to reassign, retry, or handle the failure\. Use) `get-task-details` with taskId "[^"\n]*" for full details\.([\s\S]*)$/,
  );
  if (wrapper) {
    const threadContext = wrapper[4]?.match(/<thread_context>[\s\S]*?<\/thread_context>/g) ?? [];
    query = [wrapper[2], wrapper[3], ...threadContext].join("\n\n");
  }
  query = query.trim();
  // OpenAI embeddings accept 8192 tokens. A UTF-8 byte budget of 8191 is
  // conservative for the byte-level tokenizer, even for multilingual text.
  // Iterate code points so truncation cannot split a surrogate pair.
  let bytes = 0;
  let end = 0;
  for (const character of query) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > 8191) break;
    end += character.length;
  }
  return query.slice(0, end);
}
