// `<SwarmSheet id="…" />` and `<SwarmBoard id="…" />` in Markdown files. The
// dashboard file view renders them live (`ObjectEmbed`).
//
// The tag is data: never JSX, never evaluated, never raw HTML. A remark plugin
// recognises it on a whole HTML block at the mdast stage, so `rehype-raw` never
// sees it (the HTML parser would let an unclosed custom element swallow the
// rest of the document).
//
// shortcut: this grammar is duplicated in agent-fs live
// (`live/src/lib/swarm-embed.ts`), kept in step by the shared fixture
// `swarm-embed-cases.json` (byte-identical); extract a package when a third
// consumer appears.

import { z } from "zod";

export type SwarmEmbedTag = "SwarmSheet" | "SwarmBoard";

export type SwarmEmbedProps = {
  id: string;
  tab?: string;
  range?: string;
  height?: number;
  readonly?: boolean;
  fit?: boolean;
};

export type SwarmEmbedMatch =
  | { status: "embed"; tag: SwarmEmbedTag; props: SwarmEmbedProps }
  // The shape of a tag with a rule broken. `error` is the chip's text.
  | { status: "invalid"; tag: SwarmEmbedTag; error: string }
  // Not a tag: other HTML, which stays whatever it is today.
  | { status: "none" };

const MAX_TAG_LENGTH = 512;
const TAG_PATTERN =
  /^<(SwarmSheet|SwarmBoard)((?:\s+[a-z][a-zA-Z]{0,19}="[^"<>&{}\n]{0,200}")*)\s*\/>$/;
const ATTRIBUTE_PATTERN = /\s+([a-z][a-zA-Z]{0,19})="([^"<>&{}\n]{0,200})"/g;

const HEIGHT_MESSAGE = "height must be an integer from 160 to 1200";

// One schema per attribute; the message of its first issue is the chip's reason.
const ATTRIBUTE_SCHEMAS = {
  id: z.uuid({ error: "id must be a uuid" }),
  tab: z
    .string()
    .min(1, "tab must be 1 to 100 characters")
    .max(100, "tab must be 1 to 100 characters"),
  // A cell (`B2`), a range (`A1:C10`) or whole columns (`A:C`).
  range: z
    .string()
    .regex(
      /^(?:[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?|[A-Z]{1,3}:[A-Z]{1,3})$/,
      "range must be an A1 range",
    ),
  height: z
    .string()
    .regex(/^[0-9]{1,4}$/, HEIGHT_MESSAGE)
    .transform(Number)
    .refine((n) => n >= 160 && n <= 1200, HEIGHT_MESSAGE),
  readonly: z
    .enum(["true", "false"], { error: 'readonly must be "true" or "false"' })
    .transform((v) => v === "true"),
  fit: z.literal("true", { error: 'fit must be "true"' }).transform(() => true),
} as const;

type AttributeName = keyof typeof ATTRIBUTE_SCHEMAS;

const ALLOWED: Record<SwarmEmbedTag, readonly AttributeName[]> = {
  SwarmSheet: ["id", "tab", "range", "height", "readonly"],
  SwarmBoard: ["id", "height", "readonly", "fit"],
};

/**
 * Reads the value of one `html` mdast node as a swarm embed tag. The caller
 * passes only block-level HTML (see {@link remarkSwarmEmbed}).
 */
export function matchSwarmEmbed(html: string): SwarmEmbedMatch {
  const text = html.trim();
  if (text.length > MAX_TAG_LENGTH) return { status: "none" };
  const match = TAG_PATTERN.exec(text);
  if (!match) return { status: "none" };
  const tag = match[1] as SwarmEmbedTag;
  const invalid = (reason: string): SwarmEmbedMatch => ({
    status: "invalid",
    tag,
    error: `Invalid ${tag} tag: ${reason}`,
  });

  const props: Record<string, string | number | boolean> = {};
  for (const [, name, raw] of (match[2] ?? "").matchAll(ATTRIBUTE_PATTERN)) {
    if (!name || raw === undefined) continue;
    if (!(ALLOWED[tag] as readonly string[]).includes(name)) {
      return invalid(`unknown attribute \`${name}\``);
    }
    if (name in props) return invalid(`duplicate attribute \`${name}\``);
    const read = ATTRIBUTE_SCHEMAS[name as AttributeName].safeParse(raw);
    if (!read.success) return invalid(read.error.issues[0]?.message ?? `bad ${name}`);
    props[name] = read.data;
  }
  if (!("id" in props)) return invalid("id is required");
  return { status: "embed", tag, props: props as SwarmEmbedProps };
}

// ---- remark plugin ----

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

// Parents whose children are inline text. Raw HTML under one of them is not a
// block, so a tag there is not an embed.
const PHRASING_PARENTS = new Set([
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
  "tableCell",
]);

/** The hast element a tag becomes; `COMB_MD_COMPONENTS` renders it. */
export const SWARM_EMBED_ELEMENT = "swarm-embed";

/** The `data-*` attributes `combSanitize` lets through on `swarm-embed` (hast property names). */
export const SWARM_EMBED_SANITIZE_ATTRIBUTES = [
  "dataKind",
  "dataObjectId",
  "dataTab",
  "dataRange",
  "dataHeight",
  "dataReadonly",
  "dataFit",
  "dataError",
] as const;

function toHastProperties(tag: SwarmEmbedTag, props: SwarmEmbedProps): Record<string, string> {
  const properties: Record<string, string> = {
    dataKind: tag === "SwarmSheet" ? "sheet" : "board",
    dataObjectId: props.id,
  };
  if (props.tab !== undefined) properties.dataTab = props.tab;
  if (props.range !== undefined) properties.dataRange = props.range;
  if (props.height !== undefined) properties.dataHeight = String(props.height);
  if (props.readonly !== undefined) properties.dataReadonly = String(props.readonly);
  if (props.fit !== undefined) properties.dataFit = String(props.fit);
  return properties;
}

/**
 * What a rendered `swarm-embed` element stands for, read back from its `data-*`
 * props with the same checks as the Markdown text: an embed, an error chip
 * (`data-error`), or `null` (not a swarm embed). A hand-written
 * `<swarm-embed>` cannot pass a value the grammar refuses.
 */
export type SwarmEmbedElement =
  | { status: "embed"; tag: SwarmEmbedTag; props: SwarmEmbedProps }
  | { status: "invalid"; error: string };

export function embedFromElementProps(props: Record<string, unknown>): SwarmEmbedElement {
  // Chip text from the plugin; React escapes it, and it is capped.
  if (typeof props["data-error"] === "string") {
    return { status: "invalid", error: props["data-error"].slice(0, 200) };
  }
  const tag =
    props["data-kind"] === "sheet"
      ? "SwarmSheet"
      : props["data-kind"] === "board"
        ? "SwarmBoard"
        : null;
  if (!tag) return { status: "invalid", error: "Invalid swarm embed" };
  const attributes = [
    ["id", props["data-object-id"]],
    ["tab", props["data-tab"]],
    ["range", props["data-range"]],
    ["height", props["data-height"]],
    ["readonly", props["data-readonly"]],
    ["fit", props["data-fit"]],
  ].flatMap(([name, value]) => (typeof value === "string" ? [`${name}="${value}"`] : []));
  const match = matchSwarmEmbed(`<${tag} ${attributes.join(" ")} />`);
  if (match.status === "embed") return match;
  return {
    status: "invalid",
    error: match.status === "invalid" ? match.error : "Invalid swarm embed",
  };
}

/**
 * Replaces each block-level `<SwarmSheet … />` and `<SwarmBoard … />` HTML
 * node with a `swarm-embed` element: the embed's props, or `data-error` for a
 * tag that breaks a rule (the chip). Other HTML nodes are left alone.
 */
export function remarkSwarmEmbed() {
  const visit = (parent: MdastNode) => {
    if (!parent.children || PHRASING_PARENTS.has(parent.type)) return;
    for (const node of parent.children) {
      if (node.type === "html" && typeof node.value === "string") {
        const match = matchSwarmEmbed(node.value);
        if (match.status === "none") continue;
        // An unknown node type with a `hName` becomes that element; `value`
        // is dropped so the tag text cannot reach the output.
        node.type = "swarmEmbed";
        delete node.value;
        node.data = {
          hName: SWARM_EMBED_ELEMENT,
          hProperties:
            match.status === "embed"
              ? toHastProperties(match.tag, match.props)
              : { dataError: match.error },
        };
      } else {
        visit(node);
      }
    }
  };
  return (tree: MdastNode) => visit(tree);
}
