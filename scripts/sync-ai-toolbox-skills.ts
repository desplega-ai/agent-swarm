#!/usr/bin/env bun
/**
 * Vendor the SHA-pinned ai-toolbox skill catalog into templates/skills/.
 *
 * Usage: bun run sync:ai-toolbox-skills [--repo <path-or-url>] [--ref <sha|tag>]
 *        bun run check:ai-toolbox-skills
 *
 * `--check` is deliberately network-free: it verifies only the committed
 * manifest and output files.
 *
 * `source` identifies the canonical upstream repository. When `--repo` uses a
 * different transport (for example, a fetched local clone), `syncedVia`
 * records its safe transport identity while the commit SHA remains the
 * immutable content pin. Local paths are preserved; URL credentials, query,
 * and fragment data are never persisted.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildSkillContent } from "../src/be/seed-skills/render";
import { parseSkillContent } from "../src/be/skill-parser";
import { scrubSecrets } from "../src/utils/secret-scrubber";
import type { AgentAssetConfig } from "../templates/schema";

const REPO_ROOT = join(import.meta.dir, "..");
const TEMPLATES_ROOT = join(REPO_ROOT, "templates");
const SKILLS_ROOT = join(TEMPLATES_ROOT, "skills");
const MANIFEST_PATH = join(TEMPLATES_ROOT, "ai-toolbox.manifest.json");
const DEFAULT_REPO = "https://github.com/desplega-ai/ai-toolbox.git";
const DEFAULT_REF = "main";
const EXCLUDED_SKILLS: readonly string[] = ["feedback"];
const ALLOWED_FRONTMATTER_KEYS = new Set(["name", "description", "hooks", "user-invocable"]);
const MAX_FILE_COUNT = 100;
const MAX_FILE_BYTES = 500 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const DISPLAY_NAME_OVERRIDES: Readonly<Record<string, string>> = {
  "improve-agents-md": "Improve AGENTS.md",
  qa: "QA",
  "tackle-gh-comments": "Tackle GH Comments",
  "tdd-planning": "TDD Planning",
  "v-implementing": "V-Implementing",
  "v-planning": "V-Planning",
  "wts-expert": "WTS Expert",
};

const SKILL_TAGS: Record<string, [string, string, string]> = {
  "ask-user": ["workflow", "user-input", "questions"],
  brainstorming: ["ideation", "discovery", "planning"],
  "code-reviewing": ["code-review", "quality", "verification"],
  "delegate-work": ["delegation", "agents", "orchestration"],
  "design-docs": ["documentation", "architecture", "design"],
  "engineering-standards": ["engineering", "standards", "code-quality"],
  implementing: ["implementation", "planning", "workflow"],
  "improve-agents-md": ["agent-instructions", "documentation", "configuration"],
  learning: ["learning", "knowledge", "memory"],
  "one-shot": ["implementation", "workflow", "planning"],
  "phase-running": ["implementation", "phases", "agents"],
  planning: ["planning", "implementation", "workflow"],
  qa: ["qa", "testing", "evidence"],
  questioning: ["research", "questions", "analysis"],
  researching: ["research", "codebase", "documentation"],
  reviewing: ["review", "documents", "quality"],
  "script-builder": ["scripts", "automation", "validation"],
  "step-running": ["implementation", "dag", "agents"],
  "tackle-gh-comments": ["github", "code-review", "pull-requests"],
  "tdd-planning": ["tdd", "planning", "testing"],
  "v-implementing": ["implementation", "dag", "agents"],
  "v-planning": ["planning", "dag", "parallel"],
  verifying: ["verification", "planning", "quality"],
  "wts-expert": ["git", "worktrees", "wts"],
};

export type VendoredSkillConfig = AgentAssetConfig & {
  systemDefault: true;
  userInvocable?: false;
};

export type PathRewrite = { skill: string; line: number; from: string; to: string };
type ExecutableBitDowngrade = { skill: string; path: string };

export type Manifest = {
  version: 1;
  source: string;
  syncedVia?: string;
  commit: string;
  excludedSkills: string[];
  skills: string[];
  files: Record<string, string>;
  transforms: {
    hooksDropped: string[];
    userInvocableFalse: string[];
    pathRewrites: PathRewrite[];
    executableBitsDowngraded: ExecutableBitDowngrade[];
  };
};

type TreeEntry = { mode: string; type: string; object: string; path: string };
type OutputFile = { path: string; content: string };

function redactUrls(value: string): string {
  return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"\]]+/gi, "[REDACTED:repo-url]");
}

function safeDiagnostic(value: string): string {
  return scrubSecrets(redactUrls(value));
}

export function fail(message: string): never {
  throw new Error(`[sync-ai-toolbox-skills] ${safeDiagnostic(message)}`);
}

function parseArgs(): { check: boolean; repo: string; ref: string } {
  let repo = DEFAULT_REPO;
  let ref = DEFAULT_REF;
  let check = false;

  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--repo" || arg === "--ref") {
      const value = process.argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${arg} requires a value.`);
      if (arg === "--repo") repo = value;
      else ref = value;
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  // Mirror assertSafeRepoTransport's posture for the ref: it reaches
  // `git fetch <repo> <ref>` as a positional, so reject anything that isn't a
  // plain revision (branch, tag, sha, HEAD~n, v1^{}) before git parses it.
  if (!/^[\w./@^{}~-]+$/.test(ref)) {
    fail(`--ref must be a plain git revision; got ${JSON.stringify(ref)}.`);
  }

  return { check, repo, ref };
}

function git(repo: string | null, args: string[]): Uint8Array {
  const command = ["git", ...(repo ? ["-C", repo] : []), ...args];
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
    // `git fetch` interprets exotic transports (ext::, remote helpers) that can
    // execute arbitrary commands from a crafted URL. Pin the allowed protocols
    // for every git we spawn — defense in depth behind assertSafeRepoTransport.
    env: { ...process.env, GIT_ALLOW_PROTOCOL: "file:https:http:ssh:git" },
  });
  if (result.exitCode !== 0) {
    fail(
      `git operation failed with exit code ${result.exitCode}:\n${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Accept only an existing local repository (probed by the caller) or a standard
 * git transport URL. Everything else — notably `ext::` and other remote-helper
 * schemes, which git would happily execute — is rejected before git sees it.
 */
export function assertSafeRepoTransport(repoArg: string): void {
  const allowed = /^(?:(?:https?|ssh|git|file):\/\/|[\w.-]+@[\w.-]+:)/;
  if (!allowed.test(repoArg)) {
    fail(
      `--repo must be an existing local repository or an https/ssh/git/file URL; got ${JSON.stringify(repoArg)}.`,
    );
  }
}

function gitText(repo: string | null, args: string[]): string {
  return new TextDecoder().decode(git(repo, args));
}

function parseTree(output: string): TreeEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/s);
      if (!match) fail(`Could not parse git ls-tree entry: ${line}`);
      return { mode: match[1], type: match[2], object: match[3], path: match[4] };
    });
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function structurallySorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structurallySorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, structurallySorted((value as Record<string, unknown>)[key])]),
  );
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(structurallySorted(value), null, 2)}\n`;
}

/**
 * Preserve useful sync provenance without retaining URL-borne credentials.
 * Filesystem paths are intentionally byte-preserved as operator diagnostics.
 */
export function sanitizeSyncedVia(repoArg: string): string {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(repoArg)) {
    // scp-style remotes (user@host:path) have no credential slot beyond the
    // username, but strip query/fragment suffixes so nothing appended to the
    // path can smuggle a token into the manifest.
    if (/^[\w.-]+@[\w.-]+:/.test(repoArg)) return repoArg.replace(/[?#].*$/s, "");
    return repoArg;
  }

  let url: URL;
  try {
    url = new URL(repoArg);
  } catch {
    throw new Error("Invalid repository URL transport.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function posixPath(path: string): string {
  return path.split("\\").join("/");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function titleCase(name: string): string {
  const override = DISPLAY_NAME_OVERRIDES[name];
  if (override) return override;
  return name
    .split("-")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function assertSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`Unsafe skill name: ${name}`);
}

export function assertSafeRelativePath(
  skill: string,
  path: string,
  skillsRoot = SKILLS_ROOT,
): string {
  const segments = path.split("/");
  if (
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//.test(path) ||
    path.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${skill}: unsafe bundled-file path ${JSON.stringify(path)}.`);
  }

  const filesRoot = resolve(skillsRoot, skill, "files");
  const outputPath = resolve(filesRoot, path);
  const fromFilesRoot = relative(filesRoot, outputPath);
  if (
    !fromFilesRoot ||
    isAbsolute(fromFilesRoot) ||
    fromFilesRoot === ".." ||
    fromFilesRoot.startsWith("../") ||
    fromFilesRoot.startsWith("..\\")
  ) {
    fail(`${skill}: bundled-file path escapes its files directory: ${JSON.stringify(path)}.`);
  }
  return outputPath;
}

function assertManifestOutputPath(path: string, skillNames: Set<string>): string {
  const segments = path.split("/");
  if (
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//.test(path) ||
    path.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`Unsafe manifest output path: ${JSON.stringify(path)}.`);
  }

  const [templates, skills, skill, kind, ...bundledSegments] = segments;
  if (templates !== "templates" || skills !== "skills" || !skill || !skillNames.has(skill)) {
    fail(`Manifest output path is outside its declared skill set: ${JSON.stringify(path)}.`);
  }
  assertSkillName(skill);

  if (kind === "files") {
    if (bundledSegments.length === 0) fail(`${skill}: manifest files path has no filename.`);
    const expected = assertSafeRelativePath(skill, bundledSegments.join("/"));
    if (resolve(REPO_ROOT, path) !== expected) {
      fail(
        `${skill}: manifest bundled-file path resolves inconsistently: ${JSON.stringify(path)}.`,
      );
    }
  } else if (
    !(["config.json", "content.md"].includes(kind ?? "") && bundledSegments.length === 0)
  ) {
    fail(`${skill}: unsupported manifest output path ${JSON.stringify(path)}.`);
  }

  const absolute = resolve(REPO_ROOT, path);
  const skillRoot = resolve(SKILLS_ROOT, skill);
  const fromSkillRoot = relative(skillRoot, absolute);
  if (
    !fromSkillRoot ||
    isAbsolute(fromSkillRoot) ||
    fromSkillRoot === ".." ||
    fromSkillRoot.startsWith("../") ||
    fromSkillRoot.startsWith("..\\")
  ) {
    fail(`${skill}: manifest output escapes its skill directory: ${JSON.stringify(path)}.`);
  }
  return absolute;
}

/**
 * Decode a single-quoted YAML scalar body (the text between the quotes). The
 * only escape YAML defines there is a doubled quote; a lone quote means the
 * value is not a well-formed single-quoted scalar, so the caller keeps it raw.
 */
function decodeSingleQuotedBody(inner: string): string | null {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "'") {
      out += inner[i];
      continue;
    }
    if (inner[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    return null;
  }
  return out;
}

/**
 * Decode a quoted YAML scalar, so an upstream
 * `description: "Build scripts: safely"` (or its single-quoted spelling)
 * vendors as the string it denotes instead of carrying literal quote
 * characters into the generated config, SKILL.md, and UI. Without this the
 * round-trip guard cannot catch the corruption — it compares against the
 * already-corrupted value. Double-quoted handling matches `parseSkillContent`;
 * single quotes are decoded here too because upstream skills are authored by
 * hand and YAML treats both spellings as valid. Malformed quoting falls back to
 * the raw text.
 */
function decodeYamlScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return decodeSingleQuotedBody(raw.slice(1, -1)) ?? raw;
  }
  return raw;
}

// YAML-hostile descriptions (leading indicators, `: `, ` #`, …) need no gate here:
// buildSkillContent emits them as quoted scalars and assertSkillRoundTrip proves
// the rendered file parses back verbatim.
export function assertSingleLineDescription(skill: string, description: string): void {
  if (!description || description !== description.trim() || /[\r\n]/.test(description)) {
    fail(`${skill}: description must be a non-empty single line with no surrounding whitespace.`);
  }
}

export function parseSkillMd(
  skill: string,
  source: string,
): {
  name: string;
  description: string;
  body: string;
  hooksDropped: boolean;
  userInvocableFalse: boolean;
} {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) fail(`${skill}: SKILL.md has no opening frontmatter.`);
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) fail(`${skill}: SKILL.md has no closing frontmatter.`);

  const frontmatter = normalized.slice(4, end);
  const values = new Map<string, string>();
  const keys: string[] = [];
  let currentKey: string | null = null;
  for (const line of frontmatter.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      if (currentKey === "description") {
        fail(`${skill}: description must not use YAML multi-line continuation.`);
      }
      continue;
    }

    const separator = line.indexOf(":");
    if (separator <= 0) fail(`${skill}: malformed top-level frontmatter line: ${line}`);
    currentKey = line.slice(0, separator).trim();
    if (!currentKey) fail(`${skill}: empty top-level frontmatter key.`);
    if (values.has(currentKey)) fail(`${skill}: duplicate frontmatter key ${currentKey}.`);
    keys.push(currentKey);
    values.set(currentKey, decodeYamlScalar(line.slice(separator + 1).trim()));
  }

  const unknown = keys.filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key));
  if (unknown.length > 0) {
    fail(
      `${skill}: unsupported frontmatter key(s) ${unknown.join(", ")}; refusing to silently drop them.`,
    );
  }

  const name = values.get("name") ?? "";
  const description = values.get("description") ?? "";
  if (name !== skill) fail(`${skill}: frontmatter name is ${JSON.stringify(name)}.`);
  assertSingleLineDescription(skill, description);

  const userInvocable = values.get("user-invocable");
  if (userInvocable !== undefined && !["true", "false"].includes(userInvocable)) {
    fail(`${skill}: user-invocable must be true or false, got ${JSON.stringify(userInvocable)}.`);
  }

  return {
    name,
    description,
    body: `${normalized.slice(end + 5).trim()}\n`,
    hooksDropped: values.has("hooks"),
    userInvocableFalse: userInvocable === "false",
  };
}

function rewrittenReferenceAt(body: string, start: number, prefix: string): string {
  const suffix = body.slice(start + prefix.length).match(/^[^\s`'"\])}]+/)?.[0] ?? "";
  return `${prefix}${suffix}`;
}

type ExactRewriteRule = { from: string; to: string; expectedCount: number };

/**
 * Command rewrites that cannot safely use a body-relative bundled-file path.
 * The occurrence guard covers every mention of the helper, including prose, so
 * a new upstream invocation cannot bypass the exact command rules unnoticed.
 */
const PER_SKILL_REWRITE_RULES: Readonly<
  Record<
    string,
    { occurrenceGuard: { needle: string; expectedCount: number }; rules: ExactRewriteRule[] }
  >
> = {
  "delegate-work": {
    occurrenceGuard: { needle: "codex-exec.sh", expectedCount: 5 },
    rules: [
      {
        from: `\`\${CLAUDE_PLUGIN_ROOT}/skills/delegate-work/scripts/codex-exec.sh\``,
        to: "`bash ~/.claude/skills/delegate-work/scripts/codex-exec.sh`",
        expectedCount: 1,
      },
      {
        from: "| codex-exec.sh -m",
        to: "| bash ~/.claude/skills/delegate-work/scripts/codex-exec.sh -m",
        expectedCount: 1,
      },
    ],
  },
  "tackle-gh-comments": {
    occurrenceGuard: { needle: "gh-pr-comments.ts", expectedCount: 2 },
    rules: [
      {
        from: `SKILL="\${CLAUDE_PLUGIN_ROOT}/skills/tackle-gh-comments/scripts/gh-pr-comments.ts"`,
        to: "SKILL=~/.claude/skills/tackle-gh-comments/scripts/gh-pr-comments.ts",
        expectedCount: 1,
      },
    ],
  },
};

function occurrenceCount(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor < value.length) {
    cursor = value.indexOf(needle, cursor);
    if (cursor === -1) break;
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function recordExactRewrite(
  skill: string,
  body: string,
  rule: ExactRewriteRule,
  rewrites: PathRewrite[],
): string {
  const count = occurrenceCount(body, rule.from);
  if (count !== rule.expectedCount) {
    fail(
      `${skill}: expected ${rule.expectedCount} occurrence(s) of ${JSON.stringify(rule.from)}, found ${count}.`,
    );
  }

  let rewritten = body;
  let start = rewritten.indexOf(rule.from);
  while (start !== -1) {
    rewrites.push({
      skill,
      line: rewritten.slice(0, start).split("\n").length,
      from: rule.from,
      to: rule.to,
    });
    rewritten = `${rewritten.slice(0, start)}${rule.to}${rewritten.slice(start + rule.from.length)}`;
    start = rewritten.indexOf(rule.from, start + rule.to.length);
  }
  return rewritten;
}

function hasReferenceBoundary(body: string, start: number): boolean {
  if (start === 0) return true;
  return !/[A-Za-z0-9_./-]/.test(body[start - 1] ?? "");
}

function rewritePrefixReferences(
  skill: string,
  body: string,
  prefix: string,
  targetPrefix: string,
  rewrites: PathRewrite[],
): string {
  let rewritten = body;
  let cursor = 0;
  while (cursor < rewritten.length) {
    const start = rewritten.indexOf(prefix, cursor);
    if (start === -1) break;
    if (!hasReferenceBoundary(rewritten, start)) {
      cursor = start + prefix.length;
      continue;
    }
    const from = rewrittenReferenceAt(rewritten, start, prefix);
    const to = `${targetPrefix}${from.slice(prefix.length)}`;
    rewrites.push({
      skill,
      line: rewritten.slice(0, start).split("\n").length,
      from,
      to,
    });
    rewritten = `${rewritten.slice(0, start)}${to}${rewritten.slice(start + from.length)}`;
    cursor = start + to.length;
  }
  return rewritten;
}

export function rewriteSkillReferences(
  skill: string,
  body: string,
  rewrites: PathRewrite[],
): string {
  let rewritten = body;
  const perSkill = PER_SKILL_REWRITE_RULES[skill];
  if (perSkill) {
    const actual = occurrenceCount(rewritten, perSkill.occurrenceGuard.needle);
    if (actual !== perSkill.occurrenceGuard.expectedCount) {
      fail(
        `${skill}: expected ${perSkill.occurrenceGuard.expectedCount} total occurrence(s) of ` +
          `${JSON.stringify(perSkill.occurrenceGuard.needle)}, found ${actual}; review every command context.`,
      );
    }
    for (const rule of perSkill.rules) {
      rewritten = recordExactRewrite(skill, rewritten, rule, rewrites);
    }
  }

  for (const prefix of [`cc-plugin/base/skills/${skill}/`, `cc-plugin/wts/skills/${skill}/`]) {
    rewritten = rewritePrefixReferences(skill, rewritten, prefix, "", rewrites);
  }
  rewritten = rewritePrefixReferences(
    skill,
    rewritten,
    `\${CLAUDE_PLUGIN_ROOT}/skills/${skill}/`,
    `~/.claude/skills/${skill}/`,
    rewrites,
  );

  return rewritten;
}

function assertNoRepoAbsoluteReferences(skill: string, body: string): void {
  for (const pattern of [
    /cc-plugin\/[^\s`'"\])}]+/,
    /\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/[^\s`'"\])}]+/,
  ]) {
    const match = pattern.exec(body);
    if (!match || match.index === undefined) continue;
    const line = body.slice(0, match.index).split("\n").length;
    fail(
      `${skill}: residual repository-absolute reference at body line ${line}: ${JSON.stringify(match[0])}.`,
    );
  }
}

function decodeText(skill: string, path: string, bytes: Uint8Array): string {
  if (bytes.includes(0)) fail(`${skill}: ${path} is binary (contains a NUL byte).`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${skill}: ${path} is not valid UTF-8 text.`);
  }
}

export function assertBundledFileCount(skill: string, count: number): void {
  if (count > MAX_FILE_COUNT) {
    fail(`${skill}: ${count} bundled files exceeds limit ${MAX_FILE_COUNT}.`);
  }
}

export function validateBundledFileBytes(
  skill: string,
  path: string,
  mode: string,
  bytes: Uint8Array,
  currentTotalBytes: number,
): { content: string; totalBytes: number; executableBitDowngraded: boolean } {
  if (!["100644", "100755"].includes(mode)) {
    fail(`${skill}: ${path} is not a regular text file (mode ${mode}).`);
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    fail(`${skill}: ${path} exceeds ${MAX_FILE_BYTES} bytes.`);
  }
  const totalBytes = currentTotalBytes + bytes.byteLength;
  if (totalBytes > MAX_TOTAL_BYTES) {
    fail(`${skill}: bundled files exceed ${MAX_TOTAL_BYTES} bytes total.`);
  }
  return {
    content: decodeText(skill, path, bytes),
    totalBytes,
    executableBitDowngraded: mode === "100755",
  };
}

export function assertSkillRoundTrip(config: VendoredSkillConfig, body: string): void {
  const rendered = buildSkillContent(config, body);
  const roundTrip = parseSkillContent(rendered);
  if (
    roundTrip.name !== config.name ||
    roundTrip.description !== config.description ||
    roundTrip.body !== body.trim()
  ) {
    fail(
      `${config.name}: buildSkillContent/parseSkillContent round trip changed name, description, or body.`,
    );
  }
}

async function readManifest(): Promise<{ manifest: Manifest; source: string } | null> {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) return null;
  try {
    const source = await file.text();
    return { manifest: JSON.parse(source) as Manifest, source };
  } catch (error) {
    fail(`Could not parse templates/ai-toolbox.manifest.json: ${error}`);
  }
}

export function validateManifest(
  manifest: Manifest,
  source: string,
  requireCanonicalJson = true,
): void {
  if (
    manifest.version !== 1 ||
    typeof manifest.source !== "string" ||
    manifest.source.length === 0 ||
    (manifest.syncedVia !== undefined &&
      (typeof manifest.syncedVia !== "string" || manifest.syncedVia.length === 0)) ||
    !/^[a-f0-9]{40}$/.test(manifest.commit) ||
    !Array.isArray(manifest.excludedSkills) ||
    !Array.isArray(manifest.skills) ||
    !manifest.files ||
    !manifest.transforms
  ) {
    fail("templates/ai-toolbox.manifest.json is missing required version 1 metadata.");
  }
  if (requireCanonicalJson && stableJson(manifest) !== source) {
    fail("templates/ai-toolbox.manifest.json is not deterministic 2-space JSON.");
  }
  if (manifest.excludedSkills.join("\0") !== [...EXCLUDED_SKILLS].join("\0")) {
    fail(`Manifest exclude-list must be exactly: ${EXCLUDED_SKILLS.join(", ")}.`);
  }
  if (
    requireCanonicalJson &&
    [...manifest.skills].sort().join("\0") !== manifest.skills.join("\0")
  ) {
    fail("Manifest skills must be sorted.");
  }
  if (new Set(manifest.skills).size !== manifest.skills.length) {
    fail("Manifest skills must not contain duplicates.");
  }
  const skillNames = new Set(manifest.skills);
  for (const skill of skillNames) assertSkillName(skill);
  const filePaths = Object.keys(manifest.files);
  if (requireCanonicalJson && [...filePaths].sort().join("\0") !== filePaths.join("\0")) {
    fail("Manifest file paths must be sorted.");
  }
  for (const [path, hash] of Object.entries(manifest.files)) {
    assertManifestOutputPath(path, skillNames);
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      fail(`Invalid manifest output entry: ${path} ${hash}`);
    }
  }
  for (const skill of skillNames) {
    for (const filename of ["config.json", "content.md"]) {
      const path = `templates/skills/${skill}/${filename}`;
      if (!(path in manifest.files)) fail(`${skill}: manifest is missing ${filename}.`);
    }
  }
}

async function checkOutputs(): Promise<void> {
  const loaded = await readManifest();
  if (!loaded) fail("templates/ai-toolbox.manifest.json does not exist.");
  const { manifest } = loaded;
  validateManifest(manifest, loaded.source);

  const expected = Object.keys(manifest.files).sort();
  const actual: string[] = [];
  for (const skill of manifest.skills) {
    assertSkillName(skill);
    const skillRoot = join(SKILLS_ROOT, skill);
    for await (const path of new Bun.Glob("**/*").scan({
      cwd: skillRoot,
      onlyFiles: true,
      dot: true,
    })) {
      actual.push(posixPath(relative(REPO_ROOT, join(skillRoot, path))));
    }
  }
  actual.sort();

  if (actual.join("\0") !== expected.join("\0")) {
    const missing = expected.filter((path) => !actual.includes(path));
    const extra = actual.filter((path) => !expected.includes(path));
    fail(
      `Vendored output set differs from the manifest.` +
        (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "") +
        (extra.length > 0 ? ` Extra: ${extra.join(", ")}.` : ""),
    );
  }

  for (const path of expected) {
    const absolute = assertManifestOutputPath(path, new Set(manifest.skills));
    const content = await Bun.file(absolute).text();
    if (sha256(content) !== manifest.files[path]) fail(`${path} SHA-256 does not match manifest.`);
    if ((statSync(absolute).mode & 0o111) !== 0) fail(`${path} must not be executable.`);
  }

  console.log(
    `[sync-ai-toolbox-skills] check passed for ${manifest.skills.length} skills and ${expected.length} files at ${manifest.commit}.`,
  );
}

function prepareRepository(
  repoArg: string,
  ref: string,
): {
  repo: string;
  commit: string;
  cleanup: () => void;
} {
  const localProbe = Bun.spawnSync(["git", "-C", repoArg, "rev-parse", "--git-dir"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (localProbe.exitCode === 0) {
    const commit = gitText(repoArg, ["rev-parse", `${ref}^{commit}`]).trim();
    return { repo: repoArg, commit, cleanup: () => undefined };
  }

  assertSafeRepoTransport(repoArg);

  const repo = mkdtempSync(join(tmpdir(), "ai-toolbox-skills-"));
  try {
    git(null, ["init", "--bare", repo]);
    git(repo, ["fetch", "--depth=1", repoArg, ref]);
    const commit = gitText(repo, ["rev-parse", "FETCH_HEAD^{commit}"]).trim();
    return { repo, commit, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(repo, { recursive: true, force: true });
    throw error;
  }
}

function listExistingTemplateNames(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

function buildOutputs(
  repo: string,
  commit: string,
  previousManifest: Manifest | null,
): {
  outputs: OutputFile[];
  skills: string[];
  transforms: Manifest["transforms"];
} {
  const baseEntries = parseTree(
    gitText(repo, ["ls-tree", "-z", `${commit}:cc-plugin/base/skills`]),
  );
  const baseNames = new Set(baseEntries.map((entry) => entry.path));
  for (const excluded of EXCLUDED_SKILLS) {
    if (!baseNames.has(excluded)) fail(`Excluded upstream skill ${excluded} does not exist.`);
  }

  const skills = baseEntries
    .filter((entry) => entry.type === "tree" && !EXCLUDED_SKILLS.includes(entry.path))
    .map((entry) => entry.path);
  skills.push("wts-expert");
  skills.sort();

  const previousSkills = new Set(previousManifest?.skills ?? []);
  const existing = new Set(listExistingTemplateNames());
  for (const skill of skills) {
    assertSkillName(skill);
    if (existing.has(skill) && !previousSkills.has(skill)) {
      fail(`${skill}: name collides with existing templates/skills/${skill}.`);
    }
  }

  const outputs: OutputFile[] = [];
  const hooksDropped: string[] = [];
  const userInvocableFalse: string[] = [];
  const pathRewrites: PathRewrite[] = [];
  const executableBitsDowngraded: ExecutableBitDowngrade[] = [];

  for (const skill of skills) {
    const sourceRoot =
      skill === "wts-expert" ? "cc-plugin/wts/skills/wts-expert" : `cc-plugin/base/skills/${skill}`;
    const entries = parseTree(gitText(repo, ["ls-tree", "-rz", commit, "--", sourceRoot]));
    const skillMd = entries.find((entry) => entry.path === `${sourceRoot}/SKILL.md`);
    if (!skillMd || skillMd.type !== "blob" || skillMd.mode !== "100644") {
      fail(`${skill}: expected a non-executable regular SKILL.md.`);
    }

    const parsed = parseSkillMd(
      skill,
      decodeText(skill, "SKILL.md", git(repo, ["show", `${commit}:${skillMd.path}`])),
    );
    const content = rewriteSkillReferences(skill, parsed.body, pathRewrites);
    assertNoRepoAbsoluteReferences(skill, content);
    if (parsed.hooksDropped) hooksDropped.push(skill);
    if (parsed.userInvocableFalse) userInvocableFalse.push(skill);

    const displayName = titleCase(skill);
    const config: VendoredSkillConfig = {
      kind: "skill",
      name: skill,
      displayName,
      slug: skill,
      title: displayName,
      description: parsed.description,
      version: "1.0.0",
      category: "skills",
      placeholders: [],
      runAllSeedersCandidate: true,
      systemDefault: true,
      tags: SKILL_TAGS[skill] ?? ["ai-toolbox", "agents", "workflow"],
      ...(parsed.userInvocableFalse ? { userInvocable: false as const } : {}),
    };
    assertSkillRoundTrip(config, content);

    outputs.push(
      { path: `templates/skills/${skill}/config.json`, content: stableJson(config) },
      { path: `templates/skills/${skill}/content.md`, content },
    );

    const siblingEntries = entries.filter((entry) => entry.path !== skillMd.path);
    assertBundledFileCount(skill, siblingEntries.length);

    let totalBytes = 0;
    for (const entry of siblingEntries) {
      if (entry.type !== "blob") {
        fail(`${skill}: ${entry.path} is not a regular text file (mode ${entry.mode}).`);
      }
      if (!entry.path.startsWith(`${sourceRoot}/`)) {
        fail(`${skill}: git tree returned a path outside the skill root: ${entry.path}.`);
      }
      const bundledPath = entry.path.slice(sourceRoot.length + 1);
      assertSafeRelativePath(skill, bundledPath);
      const bytes = git(repo, ["show", `${commit}:${entry.path}`]);
      const validated = validateBundledFileBytes(skill, bundledPath, entry.mode, bytes, totalBytes);
      totalBytes = validated.totalBytes;
      if (validated.executableBitDowngraded) {
        executableBitsDowngraded.push({ skill, path: bundledPath });
      }
      outputs.push({
        path: `templates/skills/${skill}/files/${bundledPath}`,
        content: validated.content,
      });
    }
  }

  outputs.sort((a, b) => compareCodeUnits(a.path, b.path));
  pathRewrites.sort((a, b) => {
    const skillOrder = compareCodeUnits(a.skill, b.skill);
    if (skillOrder !== 0) return skillOrder;
    if (a.line !== b.line) return a.line - b.line;
    return compareCodeUnits(a.from, b.from);
  });
  executableBitsDowngraded.sort((a, b) => {
    const left = `${a.skill}\0${a.path}`;
    const right = `${b.skill}\0${b.path}`;
    return compareCodeUnits(left, right);
  });

  return {
    outputs,
    skills,
    transforms: {
      hooksDropped: hooksDropped.sort(),
      userInvocableFalse: userInvocableFalse.sort(),
      pathRewrites,
      executableBitsDowngraded,
    },
  };
}

async function sync(repoArg: string, ref: string): Promise<void> {
  const prepared = prepareRepository(repoArg, ref);
  try {
    if (!/^[a-f0-9]{40}$/.test(prepared.commit)) {
      fail(`Resolved ref ${ref} to invalid commit ${prepared.commit}.`);
    }
    const loadedManifest = await readManifest();
    if (loadedManifest) {
      // A sync is also the migration path when canonical manifest formatting
      // changes. Validate deletion targets and metadata, then write the new
      // canonical form; `--check` remains strict about committed formatting.
      validateManifest(loadedManifest.manifest, loadedManifest.source, false);
    }
    const previousManifest = loadedManifest?.manifest ?? null;
    const { outputs, skills, transforms } = buildOutputs(
      prepared.repo,
      prepared.commit,
      previousManifest,
    );
    const previousSkills = previousManifest?.skills ?? [];
    const skillNames = new Set(skills);
    const validatedOutputs = outputs.map((output) => ({
      ...output,
      absolute: assertManifestOutputPath(output.path, skillNames),
    }));

    // All source validation above completes before generated directories change.
    for (const skill of new Set([...previousSkills, ...skills])) {
      assertSkillName(skill);
      rmSync(join(SKILLS_ROOT, skill), { recursive: true, force: true });
    }
    for (const output of validatedOutputs) {
      mkdirSync(dirname(output.absolute), { recursive: true });
      await Bun.write(output.absolute, output.content);
      chmodSync(output.absolute, 0o644);
      if ((statSync(output.absolute).mode & 0o111) !== 0) {
        fail(`${output.path} must not be executable.`);
      }
    }

    const files: Record<string, string> = {};
    for (const output of outputs) files[output.path] = sha256(output.content);
    // Manifest persistence is a distinct egress boundary from diagnostics:
    // sanitize URL structure first, then apply the shared credential scrubber.
    const syncedVia = scrubSecrets(sanitizeSyncedVia(repoArg));
    const manifest: Manifest = {
      version: 1,
      source: DEFAULT_REPO,
      ...(repoArg === DEFAULT_REPO ? {} : { syncedVia }),
      commit: prepared.commit,
      excludedSkills: [...EXCLUDED_SKILLS],
      skills,
      files,
      transforms,
    };
    // Validate before persisting so a bad manifest fails the sync that produced
    // it, not the next --check far from the cause.
    validateManifest(manifest, stableJson(manifest));
    await Bun.write(MANIFEST_PATH, stableJson(manifest));

    console.log(
      `[sync-ai-toolbox-skills] vendored ${skills.length} skills and ${outputs.length} files from ${prepared.commit}.`,
    );
    console.log(
      `[sync-ai-toolbox-skills] hooks dropped: ${transforms.hooksDropped.join(", ") || "none"}.`,
    );
    console.log(
      `[sync-ai-toolbox-skills] user-invocable false: ${transforms.userInvocableFalse.join(", ") || "none"}.`,
    );
    console.log(
      `[sync-ai-toolbox-skills] path rewrites: ${transforms.pathRewrites.length}; executable bits downgraded: ${transforms.executableBitsDowngraded.length}.`,
    );
  } finally {
    prepared.cleanup();
  }
}

if (import.meta.main) {
  const args = parseArgs();
  if (args.check) await checkOutputs();
  else await sync(args.repo, args.ref);
}
