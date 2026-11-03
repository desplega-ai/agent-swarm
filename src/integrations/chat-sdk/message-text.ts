import { type Message, tableToAscii } from "chat";

/**
 * The text of a chat message as the user wrote it.
 *
 * `message.text` is the SDK's plain rendering: link URLs, code fences, inline
 * code and emphasis are gone, and the agent would work from that.
 * `message.formatted` is the same content as an mdast tree, which keeps them.
 * This renders that tree back to markdown: `[text](url)` for a Slack
 * `<url|text>`, fenced blocks, `code`. Text nodes come out as typed.
 * `stringifyMarkdown` is no fit: it escapes `_`, `[` and friends, so `snake_case`
 * would reach the agent as `snake\_case` and `@my_bot !now` would stop matching
 * the mention and command checks.
 *
 * Telegram, Discord and Slack all fill `formatted`. A message without it (a
 * stored or foreign shape) falls back to the plain text.
 */
export function chatMessageText(message: Pick<Message, "text" | "formatted">): string {
  try {
    const rendered = message.formatted ? renderBlocks(message.formatted).trim() : "";
    if (rendered) return rendered;
  } catch {
    // Fall through to the plain text.
  }
  return message.text ?? "";
}

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  lang?: string | null;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  children?: MdNode[];
};

/** Block children are separated by a blank line, as in the source. */
function renderBlocks(node: MdNode): string {
  return (node.children ?? []).map(render).join("\n\n");
}

function renderInline(node: MdNode): string {
  return (node.children ?? []).map(render).join("");
}

/** A code span needs a fence longer than any backtick run inside it. */
function inlineCode(value: string): string {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

function codeBlock(value: string, lang: string | null | undefined): string {
  const longest = Math.max(2, ...(value.match(/`{3,}/gm) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang ?? ""}\n${value}\n${fence}`;
}

function renderList(node: MdNode): string {
  const start = node.start ?? 1;
  return (node.children ?? [])
    .map((item, index) => {
      const marker = node.ordered ? `${start + index}. ` : "- ";
      const pad = " ".repeat(marker.length);
      const [first = "", ...rest] = (item.children ?? []).map(render).join("\n").split("\n");
      return [`${marker}${first}`, ...rest.map((line) => (line ? pad + line : line))].join("\n");
    })
    .join("\n");
}

function render(node: MdNode): string {
  switch (node.type) {
    case "text":
    case "html":
      return node.value ?? "";
    case "inlineCode":
      return inlineCode(node.value ?? "");
    case "code":
      return codeBlock(node.value ?? "", node.lang);
    case "link": {
      const label = renderInline(node);
      return !label || label === node.url ? (node.url ?? "") : `[${label}](${node.url ?? ""})`;
    }
    case "image":
      return `![${node.alt ?? ""}](${node.url ?? ""})`;
    case "strong":
      return `**${renderInline(node)}**`;
    case "emphasis":
      return `_${renderInline(node)}_`;
    case "delete":
      return `~~${renderInline(node)}~~`;
    case "break":
      return "\n";
    case "thematicBreak":
      return "---";
    case "heading":
      return `${"#".repeat(node.depth ?? 1)} ${renderInline(node)}`;
    case "blockquote":
      return renderBlocks(node)
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    case "list":
      return renderList(node);
    case "table":
      return codeBlock(tableToAscii(node as never), null);
    case "paragraph":
      return renderInline(node);
    default:
      // Unknown node: keep what it holds rather than drop it.
      return node.children ? renderBlocks(node) : (node.value ?? "");
  }
}
