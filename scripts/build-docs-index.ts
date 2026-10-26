/**
 * Generate the docs index inside the seeded `swarm-docs` skill.
 *
 * Source of truth: `docs-site/content/docs/(documentation)/**` frontmatter
 *                  (`title`, `agent.{offer,when,notWhen,template}`) and the
 *                  `meta.json` page order.
 * Output:          the block between the docs-index markers in
 *                  `templates/skills/swarm-docs/content.md`.
 *
 * Coverage rules (fail in both modes):
 * - a page under `playbooks/` needs `agent.when` unless it sets `agent.offer: false`;
 * - a page with `agent.offer: true` needs `agent.when`.
 *
 * The seeder re-seeds on a content hash, so the skill `version` is not bumped.
 *
 * Usage: bun run build:docs-index
 *        bun run check:docs-index    # CI drift check, no write
 */

import { join, relative } from "node:path";

export const DOCS_BASE_URL = "https://docs.agent-swarm.dev/docs";
export const INDEX_START = "<!-- docs-index:start -->";
export const INDEX_END = "<!-- docs-index:end -->";

const REPO_ROOT = join(import.meta.dir, "..");
export const DOCS_ROOT = join(REPO_ROOT, "docs-site", "content", "docs", "(documentation)");
export const SKILL_CONTENT_PATH = join(
  REPO_ROOT,
  "templates",
  "skills",
  "swarm-docs",
  "content.md",
);

/** Release notes are dated changelogs, not something an agent follows. */
const SKIPPED_FOLDERS = new Set(["releases"]);

type AgentMeta = { offer?: boolean; when?: string; notWhen?: string; template?: string };

export type DocsPage = {
  /** Path under `(documentation)` without `.mdx`, e.g. `playbooks/open-oncall`. */
  path: string;
  /** URL slug after `/docs/`; an `index` page maps to its folder. */
  slug: string;
  title: string;
  agent: AgentMeta;
};

function parseFrontmatter(text: string, file: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error(`${file}: missing frontmatter`);
  const data = Bun.YAML.parse(match[1] as string);
  if (!data || typeof data !== "object") throw new Error(`${file}: frontmatter is not a map`);
  return data as Record<string, unknown>;
}

function readAgentMeta(value: unknown, file: string): AgentMeta {
  if (value === undefined) return {};
  if (!value || typeof value !== "object") throw new Error(`${file}: \`agent\` must be a map`);
  const raw = value as Record<string, unknown>;
  const meta: AgentMeta = {};
  if (raw.offer !== undefined) {
    if (typeof raw.offer !== "boolean") throw new Error(`${file}: agent.offer must be a boolean`);
    meta.offer = raw.offer;
  }
  for (const key of ["when", "notWhen", "template"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) {
      throw new Error(`${file}: agent.${key} must be a non-empty string`);
    }
    meta[key] = (raw[key] as string).trim();
  }
  return meta;
}

/** Folder entries in `meta.json` order, then any unlisted entries by name. */
async function orderedEntries(dir: string): Promise<string[]> {
  const names = new Set<string>();
  for await (const entry of new Bun.Glob("*").scan({ cwd: dir, onlyFiles: false })) {
    if (entry === "meta.json") continue;
    names.add(entry.replace(/\.mdx$/, ""));
  }
  const metaFile = Bun.file(join(dir, "meta.json"));
  const listed: string[] = (await metaFile.exists())
    ? (((await metaFile.json()) as { pages?: string[] }).pages ?? [])
    : [];
  const ordered = listed.filter((name) => names.has(name));
  const rest = [...names].filter((name) => !ordered.includes(name)).sort();
  return [...ordered, ...rest];
}

/** Walk the docs tree in sidebar order. */
export async function collectDocsPages(root: string = DOCS_ROOT): Promise<DocsPage[]> {
  const pages: DocsPage[] = [];

  async function walk(dir: string): Promise<void> {
    for (const name of await orderedEntries(dir)) {
      const file = join(dir, `${name}.mdx`);
      if (await Bun.file(file).exists()) {
        const path = relative(root, file)
          .split("\\")
          .join("/")
          .replace(/\.mdx$/, "");
        const frontmatter = parseFrontmatter(await Bun.file(file).text(), path);
        const slug = path === "index" ? "" : path.replace(/\/index$/, "");
        pages.push({
          path,
          slug,
          title: String(frontmatter.title ?? path),
          agent: readAgentMeta(frontmatter.agent, path),
        });
      } else if (!SKIPPED_FOLDERS.has(name)) {
        await walk(join(dir, name));
      }
    }
  }

  await walk(root);
  return pages;
}

const isPlaybook = (page: DocsPage) => page.path.startsWith("playbooks/");
const isGuide = (page: DocsPage) => page.path.startsWith("guides/");

/** A playbook is offered unless it opts out; any other page only when it opts in. */
export function isOffered(page: DocsPage): boolean {
  return isPlaybook(page) ? page.agent.offer !== false : page.agent.offer === true;
}

export function coverageErrors(pages: DocsPage[]): string[] {
  return pages
    .filter((page) => isOffered(page) && !page.agent.when)
    .map((page) =>
      isPlaybook(page)
        ? `${page.path}: playbook needs agent.when (or agent.offer: false)`
        : `${page.path}: agent.offer is true but agent.when is missing`,
    );
}

function entry(page: DocsPage, withTrigger: boolean): string {
  const link = `- [${page.title}](${DOCS_BASE_URL}${page.slug ? `/${page.slug}` : ""})`;
  if (!withTrigger) return link;
  if (!isOffered(page)) return `${link}. Reference.`;
  const parts = [`${link}. When: ${page.agent.when}.`];
  if (page.agent.notWhen) parts.push(`Not when: ${page.agent.notWhen}.`);
  if (page.agent.template) parts.push(`Template: \`${page.agent.template}\`.`);
  return parts.join(" ");
}

export function renderDocsIndex(pages: DocsPage[]): string {
  const playbooks = pages.filter(isPlaybook);
  const guides = pages.filter(isGuide);
  const other = pages.filter((page) => !isPlaybook(page) && !isGuide(page));
  return [
    INDEX_START,
    "<!-- Generated by `bun run build:docs-index` from the docs frontmatter. Do not edit by hand. -->",
    "",
    "## Playbooks",
    "",
    ...playbooks.map((page) => entry(page, true)),
    "",
    "## Guides",
    "",
    ...guides.map((page) => entry(page, true)),
    "",
    "## Other docs",
    "",
    ...other.map((page) => entry(page, false)),
    INDEX_END,
  ].join("\n");
}

export function replaceIndexBlock(content: string, block: string): string {
  const start = content.indexOf(INDEX_START);
  const end = content.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`swarm-docs content.md is missing the ${INDEX_START} / ${INDEX_END} markers`);
  }
  return content.slice(0, start) + block + content.slice(end + INDEX_END.length);
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const pages = await collectDocsPages();
  const errors = coverageErrors(pages);
  if (errors.length > 0) {
    console.error(`[docs-index] ${errors.length} page(s) break the coverage rules:`);
    for (const error of errors) console.error(`  - ${error}`);
    console.error("See docs-site/CLAUDE.md for the `agent` frontmatter.");
    process.exit(1);
  }

  const current = await Bun.file(SKILL_CONTENT_PATH).text();
  const next = replaceIndexBlock(current, renderDocsIndex(pages));
  if (current === next) {
    console.log(`[docs-index] up to date (${pages.length} pages)`);
  } else if (check) {
    console.error(
      "[docs-index] templates/skills/swarm-docs/content.md is stale. Run `bun run build:docs-index` and commit it.",
    );
    process.exit(1);
  } else {
    await Bun.write(SKILL_CONTENT_PATH, next);
    console.log(
      `[docs-index] wrote ${pages.length} pages to templates/skills/swarm-docs/content.md`,
    );
  }
}
