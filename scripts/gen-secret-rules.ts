/**
 * Generate the scrubber's vendor-shape rules from the gitleaks default config.
 *
 * Source of truth: `scripts/vendor/gitleaks/gitleaks.toml` (MIT, pinned to an
 *                  upstream commit in its header and verified by sha256)
 * Output:          `src/utils/secret-rules.generated.ts`
 *
 * gitleaks writes Go (RE2) regexes. `convertGoRegex` rewrites the few RE2-only
 * forms into JS: a leading `(?i)` becomes the `i` flag, a mid-pattern `(?i)`
 * becomes a scoped `(?i:…)`, `(?P<` becomes `(?<`, POSIX classes expand,
 * `\z`/`\A` become `$`/`^`, and a `]` that opens a class is escaped. Anything
 * else RE2-only fails the run, so a refresh never ships a silently wrong rule.
 *
 * Usage:  bun run build:secret-rules
 *         bun run check:secret-rules    # CI drift check, no write
 */

import { createHash } from "node:crypto";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const VENDOR_PATH = join(REPO_ROOT, "scripts", "vendor", "gitleaks", "gitleaks.toml");
const OUT_PATH = join(REPO_ROOT, "src", "utils", "secret-rules.generated.ts");
const MARKER = "# ---- upstream gitleaks.toml below ----\n";

/** Rules we drop on purpose. A path-scoped rule is dropped automatically. */
const EXCLUDED: Record<string, string> = {
  "generic-api-key":
    "entropy on any key-like word; noisy on agent prose, and the scrubber's key-context pass covers sensitive keys",
  "curl-auth-header":
    "the key-context pass already redacts auth headers; its unbounded multi-line `.*?` backtracks in JS",
  "curl-auth-user":
    "the key-context pass already redacts curl -u/--user; its unbounded multi-line `.*` backtracks in JS",
  "private-key": "the key-context pass already redacts PEM private-key blocks",
};

/**
 * Rules whose secret is the whole match, not the first capture group. gitleaks
 * reports the first non-empty group, which here is a named group that labels
 * the JWT header field.
 */
const REDACT_WHOLE_MATCH = new Set(["jwt-base64"]);

export interface ConvertedRegex {
  source: string;
  flags: string;
}

const POSIX_CLASSES: Record<string, string> = {
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
  space: String.raw` \t\r\n\v\f`,
  word: String.raw`\w`,
};

function checkEscape(go: string, next: string | undefined, at: number): void {
  if (next === undefined) throw new Error(`trailing backslash at ${at} in ${go}`);
  if ("QECpP".includes(next)) throw new Error(`unsupported escape \\${next} at ${at} in ${go}`);
  if (next === "x" && go[at + 2] === "{") throw new Error(`unsupported \\x{…} at ${at} in ${go}`);
}

/** Rewrite one RE2 pattern as a JS regex source + flags. Throws on RE2-only syntax. */
export function convertGoRegex(go: string): ConvertedRegex {
  let src = go;
  let flags = "";
  if (src.startsWith("(?i)")) {
    flags = "i";
    src = src.slice(4);
  }

  // One entry per open group. `ciWrap` = a mid-pattern `(?i)` opened a scoped
  // `(?i:` at this level, which must close before the group's `)` and around
  // each later `|` branch (RE2 keeps the flag to the end of the group).
  const stack: { ciWrap: boolean }[] = [];
  const top = { ciWrap: false };
  const level = () => stack[stack.length - 1] ?? top;
  let out = "";
  let i = 0;

  while (i < src.length) {
    const c = src[i] as string;

    if (c === "\\") {
      const next = src[i + 1];
      checkEscape(go, next, i);
      if (next === "z") out += "$";
      else if (next === "A") out += "^";
      else out += c + next;
      i += 2;
      continue;
    }

    if (c === "[") {
      let j = i + 1;
      let cls = "[";
      if (src[j] === "^") {
        cls += "^";
        j++;
      }
      // RE2: a `]` right after `[` or `[^` is a literal. In JS it closes the class.
      if (src[j] === "]") {
        cls += "\\]";
        j++;
      }
      while (j < src.length && src[j] !== "]") {
        if (src[j] === "\\") {
          checkEscape(go, src[j + 1], j);
          cls += src.slice(j, j + 2);
          j += 2;
        } else if (src.startsWith("[:", j)) {
          const end = src.indexOf(":]", j + 2);
          const expansion = end === -1 ? undefined : POSIX_CLASSES[src.slice(j + 2, end)];
          if (expansion === undefined) throw new Error(`unsupported POSIX class at ${j} in ${go}`);
          cls += expansion;
          j = end + 2;
        } else if (src[j] === "[") {
          cls += "\\[";
          j++;
        } else {
          cls += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new Error(`unterminated character class in ${go}`);
      out += `${cls}]`;
      i = j + 1;
      continue;
    }

    if (c === "(") {
      const flagSet = /^\(\?([a-zA-Z-]*)\)/.exec(src.slice(i));
      if (flagSet) {
        if (flagSet[1] !== "i") throw new Error(`unsupported inline flags ${flagSet[0]} in ${go}`);
        const lvl = level();
        if (!flags.includes("i") && !lvl.ciWrap) {
          out += "(?i:";
          lvl.ciWrap = true;
        }
        i += flagSet[0].length;
        continue;
      }
      const scoped = /^\(\?([a-zA-Z-]*):/.exec(src.slice(i));
      if (scoped && !/^-?[is]*$/.test(scoped[1] as string)) {
        throw new Error(`unsupported scoped flags ${scoped[0]} in ${go}`);
      }
      stack.push({ ciWrap: false });
      if (src.startsWith("(?P<", i)) {
        out += "(?<";
        i += 4;
      } else {
        out += c;
        i++;
      }
      continue;
    }

    if (c === ")") {
      const group = stack.pop();
      if (!group) throw new Error(`unbalanced ) in ${go}`);
      out += group.ciWrap ? "))" : ")";
      i++;
      continue;
    }

    if (c === "|") {
      out += level().ciWrap ? ")|(?i:" : "|";
      i++;
      continue;
    }

    out += c;
    i++;
  }

  if (stack.length > 0) throw new Error(`unbalanced ( in ${go}`);
  if (top.ciWrap) out += ")";
  // Fail here, not at scrub time, if the rewrite is not a valid JS regex.
  new RegExp(out, `${flags}gd`);
  return { source: out, flags };
}

const KEY_PREFIX = String.raw`[\w.-]{0,50}?`;

/**
 * Drop the leading `[\w.-]{0,50}?` of a keyword-context rule (also when it
 * repeats inside a leading `(?i:`). It only widens the match leftwards over
 * the key name, so the secret group is unchanged, but a backtracking engine
 * pays up to 50 steps for it at every input position: ~8 s per rule on a
 * 100 KB keyword run, vs RE2's linear scan.
 */
export function stripKeyPrefix(source: string): string {
  let out = source;
  if (out.startsWith(KEY_PREFIX)) out = out.slice(KEY_PREFIX.length);
  if (out.startsWith(`(?i:${KEY_PREFIX}`)) out = `(?i:${out.slice(4 + KEY_PREFIX.length)}`;
  return out;
}

interface GitleaksAllowlist {
  regexTarget?: string;
  regexes?: string[];
  stopwords?: string[];
  paths?: string[];
  condition?: string;
}

interface GitleaksRule {
  id: string;
  regex?: string;
  keywords?: string[];
  entropy?: number;
  secretGroup?: number;
  path?: string;
  allowlists?: GitleaksAllowlist[];
}

function parseVendored(text: string): { version: string; commit: string; body: string } {
  const at = text.indexOf(MARKER);
  if (at === -1) throw new Error(`marker line missing from ${VENDOR_PATH}`);
  const header = text.slice(0, at);
  const body = text.slice(at + MARKER.length);
  const field = (name: string) => {
    const m = new RegExp(`^# ${name}: (\\S+)$`, "m").exec(header);
    if (!m) throw new Error(`header field "${name}" missing from ${VENDOR_PATH}`);
    return m[1] as string;
  };
  const expected = field("sha256");
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `vendored gitleaks.toml body sha256 is ${actual}, header says ${expected}. ` +
        "The body must be byte-identical to upstream; refresh it per the header.",
    );
  }
  return { version: field("version"), commit: field("commit"), body };
}

function convertAllowlist(rule: GitleaksRule, ruleRe: RegExp, list: GitleaksAllowlist) {
  if (list.condition && list.condition.toUpperCase() !== "OR") {
    throw new Error(`rule ${rule.id}: allowlist condition ${list.condition} is not supported`);
  }
  const target = list.regexTarget ?? "secret";
  if (target !== "secret" && target !== "match") {
    throw new Error(`rule ${rule.id}: allowlist regexTarget ${target} is not supported`);
  }
  // An entry the rule itself matches is a literal example secret (gcp-api-key
  // lists real-looking keys). Keeping it would put secret-shaped strings in
  // the generated file, and redacting an example key costs nothing.
  const regexes = (list.regexes ?? []).filter((re) => {
    ruleRe.lastIndex = 0;
    return !ruleRe.test(re);
  });
  return {
    target,
    regexes: regexes.map(convertGoRegex),
    stopwords: (list.stopwords ?? []).map((w) => w.toLowerCase()),
  };
}

export function generate(text: string): string {
  const { version, commit, body } = parseVendored(text);
  const config = Bun.TOML.parse(body) as {
    allowlist?: GitleaksAllowlist;
    rules: GitleaksRule[];
  };

  const excluded: { id: string; reason: string }[] = [];
  const rules = [];
  for (const rule of config.rules) {
    const reason =
      EXCLUDED[rule.id] ??
      (rule.path ? "path-scoped: gitleaks applies it to matching file names only" : undefined) ??
      (rule.regex ? undefined : "no content regex");
    if (reason) {
      excluded.push({ id: rule.id, reason });
      continue;
    }
    const converted = convertGoRegex(rule.regex as string);
    const regex = { source: stripKeyPrefix(converted.source), flags: converted.flags };
    const ruleRe = new RegExp(regex.source, `${regex.flags}g`);
    const allowlists = (rule.allowlists ?? [])
      .filter((list) => list.regexes?.length || list.stopwords?.length)
      .map((list) => convertAllowlist(rule, ruleRe, list))
      .filter((list) => list.regexes.length > 0 || list.stopwords.length > 0);
    rules.push({
      id: rule.id,
      ...regex,
      keywords: [...new Set((rule.keywords ?? []).map((k) => k.toLowerCase()))],
      ...(rule.entropy ? { entropy: rule.entropy } : {}),
      ...(rule.secretGroup ? { secretGroup: rule.secretGroup } : {}),
      ...(REDACT_WHOLE_MATCH.has(rule.id) ? { redactWholeMatch: true } : {}),
      ...(allowlists.length > 0 ? { allowlists } : {}),
    });
  }
  for (const id of Object.keys(EXCLUDED)) {
    if (!config.rules.some((rule) => rule.id === id)) {
      throw new Error(`EXCLUDED lists ${id}, which the vendored config no longer has`);
    }
  }

  const global = config.allowlist ?? {};
  const data = {
    version,
    commit,
    globalAllowlist: {
      regexes: (global.regexes ?? []).map(convertGoRegex),
      stopwords: (global.stopwords ?? []).map((w) => w.toLowerCase()),
    },
    rules,
    excluded,
  };

  return `// GENERATED by scripts/gen-secret-rules.ts from scripts/vendor/gitleaks/gitleaks.toml.
// Do not edit. Run \`bun run build:secret-rules\` after changing the vendored config
// or the generator. ${rules.length} rules kept, ${excluded.length} excluded (reasons below).

export interface GeneratedRegex {
  source: string;
  flags: string;
}

export interface GeneratedAllowlist {
  /** What the allowlist regexes test: the secret, or the whole rule match. */
  target: "secret" | "match";
  regexes: GeneratedRegex[];
  /** Lowercase; a secret containing one is allowed. */
  stopwords: string[];
}

export interface GeneratedSecretRule extends GeneratedRegex {
  id: string;
  /** Lowercase; the rule runs only when the text contains one of them. */
  keywords: string[];
  /** Minimum Shannon entropy of the secret; at or below it is not a finding. */
  entropy?: number;
  /** Capture group holding the secret. Default: the first non-empty group, else the match. */
  secretGroup?: number;
  redactWholeMatch?: boolean;
  allowlists?: GeneratedAllowlist[];
}

export interface GeneratedSecretRuleSet {
  version: string;
  commit: string;
  globalAllowlist: { regexes: GeneratedRegex[]; stopwords: string[] };
  rules: GeneratedSecretRule[];
  excluded: { id: string; reason: string }[];
}

export const GITLEAKS_RULES: GeneratedSecretRuleSet = ${allowScannerOnPatternLines(JSON.stringify(data, null, 2))};
`;
}

/**
 * Pattern text describes secret shapes, so the repo's own gitleaks scan flags
 * some of it (a literal vendor prefix, the 40-hex upstream commit). The file
 * holds no secret by construction (literal example allowlist entries are
 * dropped above), so mark those lines with gitleaks' inline allow comment.
 */
function allowScannerOnPatternLines(json: string): string {
  return json.replace(/^(\s*"(?:source|commit)": .*,)$/gm, "$1 // gitleaks:allow");
}

if (import.meta.main) {
  let generated: string;
  try {
    generated = generate(await Bun.file(VENDOR_PATH).text());
  } catch (error) {
    console.error(`[gen-secret-rules] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (process.argv.includes("--check")) {
    const out = Bun.file(OUT_PATH);
    const current = (await out.exists()) ? await out.text() : "";
    if (current !== generated) {
      console.error(
        "[gen-secret-rules] src/utils/secret-rules.generated.ts is stale.\n" +
          "Run `bun run build:secret-rules` and commit the result.",
      );
      process.exit(1);
    }
    console.log("[gen-secret-rules] secret-rules.generated.ts is up to date.");
  } else {
    await Bun.write(OUT_PATH, generated);
    console.log(`[gen-secret-rules] wrote ${OUT_PATH}`);
  }
}
