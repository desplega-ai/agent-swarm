/**
 * Atlassian Document Format (ADF) walker.
 *
 * Jira REST v3 returns rich-text fields (issue descriptions, comment bodies)
 * as ADF JSON trees. We need plaintext for prompt rendering and structured
 * mention extraction for bot-mention detection on inbound webhooks.
 *
 * Reference: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 *
 * Supported node types: paragraph, heading, bulletList, orderedList, listItem,
 * text, mention, hardBreak, codeBlock, blockquote. Unknown types descend into
 * `content` if present, else are skipped silently. In non-prod environments a
 * debug line is emitted so unhandled cases surface during dev.
 */

type AdfNode = {
  type?: string;
  text?: string;
  content?: unknown[];
  attrs?: Record<string, unknown>;
};

function isNode(value: unknown): value is AdfNode {
  return !!value && typeof value === "object";
}

function asNodeArray(value: unknown): AdfNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isNode);
}

/**
 * Recursively concatenate text from an ADF tree. Mentions are inlined as
 * `@<displayName>` (or `@<accountId>` if no displayName is present).
 *
 * Block-level nodes insert a trailing newline so consecutive paragraphs render
 * as separate lines. Hard breaks and list items also produce newlines.
 */
export function extractText(adf: unknown): string {
  if (!isNode(adf)) return "";

  const out: string[] = [];

  const visit = (node: AdfNode): void => {
    const type = typeof node.type === "string" ? node.type : "";

    switch (type) {
      case "text": {
        if (typeof node.text === "string") out.push(node.text);
        return;
      }
      case "mention": {
        const attrs = node.attrs ?? {};
        const text = typeof attrs.text === "string" ? attrs.text : null;
        const id = typeof attrs.id === "string" ? attrs.id : null;
        const display = text ?? id ?? "";
        // Atlassian mention `text` already starts with "@" sometimes; normalize
        // to a single leading "@".
        out.push(display.startsWith("@") ? display : `@${display}`);
        return;
      }
      case "hardBreak": {
        out.push("\n");
        return;
      }
      case "paragraph":
      case "heading":
      case "blockquote":
      case "codeBlock": {
        for (const child of asNodeArray(node.content)) visit(child);
        out.push("\n");
        return;
      }
      case "bulletList":
      case "orderedList": {
        for (const child of asNodeArray(node.content)) visit(child);
        return;
      }
      case "listItem": {
        out.push("- ");
        for (const child of asNodeArray(node.content)) visit(child);
        // Block children inside a listItem already trail a newline, so we don't
        // double-add. But if the listItem only contained inline content, ensure
        // we end on a newline.
        if (out.length > 0 && !out[out.length - 1]?.endsWith("\n")) {
          out.push("\n");
        }
        return;
      }
      case "doc": {
        for (const child of asNodeArray(node.content)) visit(child);
        return;
      }
      default: {
        // Unknown node — descend into content if present.
        if (process.env.NODE_ENV !== "production" && type) {
          console.log(`[jira.adf] unknown node type: ${type}`);
        }
        for (const child of asNodeArray(node.content)) visit(child);
        return;
      }
    }
  };

  visit(adf);

  // Collapse trailing whitespace, preserve internal newlines.
  return out.join("").replace(/\n+$/g, "");
}

/**
 * Collect Atlassian `accountId` values from every `mention` node in the tree.
 * Returns an empty array when no mentions exist or the input is malformed.
 */
export function extractMentions(adf: unknown): string[] {
  if (!isNode(adf)) return [];

  const ids: string[] = [];

  const visit = (node: AdfNode): void => {
    if (node.type === "mention") {
      const id = node.attrs?.id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
      return;
    }
    for (const child of asNodeArray(node.content)) visit(child);
  };

  visit(adf);

  return ids;
}
