/**
 * Runtime secret scrubber for log/stdout/stderr emission.
 *
 * Exported `scrubSecrets(text)` replaces known sensitive values with
 * `[REDACTED:<name>]` placeholders. Used at every text-egress point (adapter
 * log files, session-log uploads, pretty-printed stdout, stderr dumps) so
 * credentials set via `swarm_config` or container env never leak into
 * /workspace/logs/*.jsonl, the `session_logs` SQLite table, or container
 * stdout shipped to log aggregators.
 *
 * Two sources are combined:
 *   1. `process.env` values of known-sensitive keys (either exact names or
 *      suffix-matched like *_API_KEY, *_TOKEN, *_SECRET). These are the
 *      concrete strings the worker actually holds.
 *   2. Structural regex patterns for well-known token shapes (GitHub PATs,
 *      OpenAI keys, Slack tokens, JWTs, …). Covers cases where a secret
 *      arrived via a tool result without ever being in our env.
 *
 * This module is deliberately worker/API neutral — it reads only from
 * `process.env` so it can be imported from both sides without violating the
 * API↔worker DB boundary (scripts/check-db-boundary.sh).
 */

import { openAICompatibleKeyVars } from "@desplega/model-catalog";
import { LiteralMatcher } from "./literal-matcher";
import { GITLEAKS_RULES } from "./secret-rules.generated";

/**
 * Version of the redaction rules below. Bump it on EVERY rule change (new
 * key, suffix, regex, pass or threshold): the API's boot retro-sweep
 * (src/be/boot-scrub-sweep.ts) keys its done marker on this number and
 * re-scrubs stored rows once per version. v2 = the #1907 rules, swept over
 * session_logs only; v3 = the first version swept across every target table;
 * v4 = the API's secret registry (src/be/secret-registry.ts) registers every
 * stored secret at boot, plus its base64, base64url and URL-encoded forms, and
 * the known-value pass matches them all through one combined regex; v5 = pass
 * 5, the vendored gitleaks rule set, plus hand-written Resend, Google OAuth,
 * Discord webhook, xAI and bare Telegram shapes in pass 2; v6 = pass 5 resumes
 * after the secret, not the match, so adjacent secrets that share a delimiter
 * both redact, and sourcegraph-access-token drops its bare 40-hex branch;
 * v7 = the OpenAI-compatible registry key vars (`NAN_API_KEY`,
 * `HELMCODE_API_KEY`, and the `HELMCODE_API_NAN` alias no suffix matches).
 * A new registry entry adds key vars, so it is a rule change too
 * (`secret-scrubber.test.ts` pins the list to this number).
 * v10 = the sweep covers the dreaming-v2 KV namespace and decodes its legacy
 * hex copies. A new sweep target needs a bump too: an install that finished
 * the previous version never sweeps it otherwise.
 * v11 = a pass 2 hit inside a longer gitleaks secret redacts that whole
 * secret, so a generic `sk-` match in a Heroku key's tail no longer leaves
 * the key's prefix behind.
 * v12 = the gitleaks global allowlist `^true|false|null$` is anchored as a
 * whole, so a secret containing "false", starting with "true" or ending with
 * "null" is no longer allowed.
 * v13 = pass 2 redacts Convex deploy keys (`prod:`, `dev:`, `preview:`,
 * `project:`; `|` or `%7C`), and pass 1 also matches each known value's
 * URL-decoded and URL-encoded forms.
 * v14 = pass 1 also matches a known value URL-encoded as stored, so a value
 * with a literal `%` is redacted in its `%25` form.
 */
export const SCRUBBER_RULES_VERSION = 14;

/** Env-var names that are always considered secrets, even without suffix hints. */
const SENSITIVE_KEY_EXACT = new Set<string>([
  "API_KEY",
  "SECRETS_ENCRYPTION_KEY",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "AZURE_DEVOPS_TOKEN",
  // Worker-side copy of AZURE_DEVOPS_TOKEN read by the az azure-devops extension
  "AZURE_DEVOPS_EXT_PAT",
  // The `_TOKEN` / `_SECRET` suffixes already match these, so listing them
  // does not change redaction and does not bump SCRUBBER_RULES_VERSION.
  "BITBUCKET_TOKEN",
  "BITBUCKET_WEBHOOK_SECRET",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  // OpenAI-compatible registry key vars, canonical and alias. An alias such
  // as `HELMCODE_API_NAN` matches no SENSITIVE_KEY_SUFFIXES entry.
  ...openAICompatibleKeyVars(),
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_CLIENT_SECRET",
  "SLACK_USER_TOKEN",
  "SLACK_APP_TOKEN",
  "SENTRY_AUTH_TOKEN",
  "VERCEL_TOKEN",
  "RESEND_API_KEY",
  "AGENTMAIL_API_KEY",
  "API_AGENT_FS_API_KEY",
  "AGENT_FS_API_KEY",
  "BUSINESS_USE_API_KEY",
  "QA_USE_API_KEY",
  "DOCS_API_KEY",
  "DOKPLOY_API_KEY",
  "DEVTO_API_KEY",
  "ELEVENLABS_API_KEY",
  "ENGINY_API_KEY",
  "OPENFORT_API_KEY",
  "OPENFORT_TEST_SECRET_KEY",
  "OPENFORT_TEST_WALLET_PRIVATE_KEY",
  "OPENFORT_WALLET_SECRET",
  "TURSO_API_TOKEN",
  "TURSO_DB_TOKEN",
  "TURSO_X_POSTS_DB_TOKEN",
  "BROWSER_USE_API_KEY",
  "PLAUSIBLE_API_KEY",
  "IMGFLIP_PASSWORD",
  "GSC_SERVICE_ACCOUNT_BASE64",
  "LINEAR_API_KEY",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "SIGNOZ_INGESTION_KEY",
  // Bare names, as they appear in .env files, JSON/YAML configs and headers.
  // `PWD` is deliberately absent: it is the shell's working directory.
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "TOKEN",
  "PRIVATE_KEY",
  "APIKEY",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "CLIENT_SECRET",
  "AUTHORIZATION",
  "CREDENTIALS",
]);

/**
 * Suffixes that mark an env-var value as sensitive by convention. There is no
 * bare `_KEY` suffix: it would match `SORT_KEY`, `PRIMARY_KEY`, `contextKey`.
 */
const SENSITIVE_KEY_SUFFIXES = [
  "_API_KEY",
  "_TOKEN",
  "_SECRET",
  "_PASSWORD",
  "_PASS",
  "_PRIVATE_KEY",
  "_ACCESS_KEY",
  "_SECRET_KEY",
  "_APIKEY",
  "_AUTH_HEADER",
  "_CREDENTIALS",
  "_DSN",
  "_DEPLOY_KEY",
];

/** Keys that match the sensitive suffix heuristic but are actually safe URLs/configs. */
const NON_SECRET_EXCEPTIONS = new Set<string>([
  "MCP_BASE_URL",
  "APP_URL",
  "API_URL",
  "TEMPLATE_REGISTRY_URL",
  // A file path, not the credential itself.
  "GOOGLE_APPLICATION_CREDENTIALS",
  // Pagination cursors. Tool results are scrubbed before the model sees them,
  // so redacting these would break paging through an API response.
  "PAGE_TOKEN",
  "NEXT_PAGE_TOKEN",
  "PREV_PAGE_TOKEN",
  "NEXT_TOKEN",
  "CONTINUATION_TOKEN",
  "SYNC_TOKEN",
  "NEXT_SYNC_TOKEN",
]);

/**
 * Canonical form of a key name for the sensitivity check: camelCase becomes
 * snake case (`apiKey` → `API_KEY`), `.` and `-` become `_`, and the result is
 * uppercased. An all-caps key is never split (`OAUTH2TOKEN` stays whole).
 */
export function normalizeKey(key: string): string {
  if (!/[a-z.-]/.test(key)) return key;
  let out = key;
  if (/[a-z]/.test(out) && /[A-Z]/.test(out)) {
    out = out.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  }
  return out.replace(/[.-]/g, "_").toUpperCase();
}

/**
 * Minimum length for an env-var value to be considered scrub-worthy.
 * Short values (< 12 chars) cause false-positive replacements across
 * legitimate log content (e.g. a 6-char password would collide with a user
 * name). Short secrets are still caught when they appear as the value of a
 * sensitive `KEY=value` assignment (see ASSIGNMENT_RE).
 */
const MIN_VALUE_LENGTH = 12;

/**
 * A known value, the value URL-encoded, its URL-decoded form and that form
 * URL-encoded. A secret stored percent-encoded (`a%7Cb`) is often decoded
 * before use (`${KEY//%7C/|}`), and a raw one is encoded into URLs, so any of
 * these can reach a log without equalling the stored value. The stored value
 * is encoded directly too: a literal `%` in it (`abc%41x`) makes the decoded
 * form a different string, or makes decoding throw.
 */
export function urlForms(value: string): string[] {
  const forms = new Set([value]);
  const addDerived = (derive: () => string[]) => {
    try {
      for (const form of derive()) forms.add(form);
    } catch {
      // Not valid percent-encoding, or a lone surrogate: skip this form.
    }
  };
  addDerived(() => [encodeURIComponent(value)]);
  addDerived(() => {
    const decoded = decodeURIComponent(value);
    return [decoded, encodeURIComponent(decoded)];
  });
  return [...forms];
}

/**
 * Every form a known value can take in a log line: raw, URL-decoded and
 * URL-encoded (see `urlForms`), each escaped inside shell double quotes
 * (`declare -x` / `export -p` prefix `\`, `$`, `"` and backtick with a
 * backslash), inside shell single quotes, and each of those again as a JSON
 * string body (session logs are JSONL). A URL form shorter than
 * MIN_VALUE_LENGTH is dropped; the caller has already checked `value`.
 */
function escapedForms(value: string): string[] {
  const forms = new Set<string>();
  for (const base of urlForms(value)) {
    if (base !== value && base.length < MIN_VALUE_LENGTH) continue;
    forms.add(base);
    forms.add(base.replace(/[\\$"`]/g, "\\$&"));
    forms.add(base.replaceAll("'", "'\\''"));
  }
  for (const form of [...forms]) forms.add(JSON.stringify(form).slice(1, -1));
  return [...forms];
}

// Value shapes after `KEY=`. Each one consumes escape pairs whole, so the
// first unescaped closing quote ends the value.
//   JSON_DQ: `\"…\"` — a shell double-quoted value inside a JSON string.
//   RAW_DQ:  `"…"`   — a shell double-quoted value (`declare -x KEY="…"`).
//   SQ:      `'…'`   — a shell single-quoted value, raw or JSON (`'\''`).
//   BARE:    unquoted, up to whitespace, a quote, or a JSON escape (`\n`).
// A bare or double-quoted value starting with an unescaped `$` is a shell
// reference (`$VAR`, `${VAR}`, `$(cmd)`), not a secret; `declare -x` writes a
// literal `$` as `\$`, so dumps still match.
//
// A quoted value may span lines only when its closing quote ends a line, as a
// multi-line value in an env dump does. An unterminated quote (or one whose
// close sits mid-line further down) stops at the first newline, raw or JSON
// `\n`, so it never swallows the rest of the text.
const QUOTE_EOL = String.raw`(?=$|[\r\n]|\\[rn]|")`;
function quoted(open: string, close: string, item: string, lineItem: string): string {
  return `${open}(?:(?:${lineItem})*${close}|(?:${item})*${close}${QUOTE_EOL}|(?:${lineItem})*)`;
}
const JSON_DQ = quoted(
  String.raw`\\"(?!\$)`,
  String.raw`\\"`,
  String.raw`\\\\(?:\\\\|\\"|[^\\"])|\\[^\\"]|[^"\\]`,
  String.raw`\\\\(?:\\\\|\\"|[^\\"\r\n])|\\[^\\"nr\r\n]|[^"\\\r\n]`,
);
const RAW_DQ = quoted(
  `"(?!\\$)`,
  `"`,
  String.raw`\\[\s\S]|[^"\\]`,
  String.raw`\\[^\r\n]|[^"\\\r\n]`,
);
const SQ = quoted(
  `'`,
  `'`,
  String.raw`[^'\\]|'\\\\?''|\\[\s\S]`,
  String.raw`[^'\\\r\n]|'\\\\?''|\\[^nr\r\n]`,
);
const BARE = String.raw`(?!\$)(?:\\[^nrtu"\s]|[^\s"'\\])+`;

/**
 * `KEY=value` where the value is redacted when KEY is sensitive, whatever the
 * value's length and whether this process ever saw it (e.g. a token the
 * harness generated inside a child process). The key must start a word or
 * follow a JSON `\n`/`\r`/`\t` escape, and may contain dots
 * (`SLACK.BOT.TOKEN=`). `==` comparisons are not assignments. There is no
 * whitespace around `=` here, so `const password = getPassword()` in a logged
 * diff is never touched; spaced `key = value` is only matched line-anchored
 * (INI_ASSIGNMENT_RE).
 */
const ASSIGNMENT_RE = new RegExp(
  String.raw`(?:(?<=\\[nrt])|(?<![\w\\.]))([A-Za-z_][A-Za-z0-9_.]*)=(?!=)(${JSON_DQ}|${RAW_DQ}|${SQ}|${BARE})`,
  "g",
);

/** A dotted key is sensitive when the whole name or its last segment is. */
function isSensitiveKeyPath(key: string): boolean {
  if (isSensitiveKey(key)) return true;
  const dot = key.lastIndexOf(".");
  return dot >= 0 && isSensitiveKey(key.slice(dot + 1));
}

function redactAssignment(match: string, key: string, value: string): string {
  if (!isSensitiveKeyPath(key)) return match;
  let open = "";
  let close = "";
  for (const quote of ['\\"', '"', "'"]) {
    if (!value.startsWith(quote)) continue;
    open = quote;
    if (value.length >= quote.length * 2 && value.endsWith(quote)) close = quote;
    break;
  }
  const inner = value.slice(open.length, value.length - close.length);
  if (inner === "" || /^\[REDACTED:[^\]]*\]$/.test(inner)) return match;
  return `${key}=${open}[REDACTED:${key}]${close}`;
}

/**
 * Values the key-context rules leave alone: empty, already redacted, a
 * reference or template (`$VAR`, `${{ … }}`, `<your-token>`, `***`, `%VAR%`,
 * `{{ x }}`), a YAML/JSON literal, or a bare number.
 */
function isPlaceholderValue(value: string): boolean {
  return (
    value === "" ||
    value.includes("[REDACTED") ||
    /^[$<*%{]/.test(value) ||
    /^(?:null|none|nil|true|false|yes|no|undefined|~)$/i.test(value) ||
    /^[+-]?\d+(?:\.\d+)?$/.test(value)
  );
}

/**
 * An unquoted right-hand side that reads as code or prose rather than a
 * literal credential: a call, index, object or list (`get_token()`,
 * `env["X"]`), a trailing `,`/`;`, a member chain (`process.env.TOKEN`), or a
 * short plain word (`string`, `pwd`, `required`) as in a TS type or a name.
 */
function looksLikeCode(value: string): boolean {
  return (
    /[()[\]{};,]/.test(value) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) ||
    (/^[A-Za-z_]+$/.test(value) && value.length < 16)
  );
}

// Line boundaries, raw or as JSON `\n`/`\r` escapes inside a session-log
// string (whose closing `"` also ends the last line).
const LINE_START = String.raw`(?:^|(?<=\\[nr]))`;
const LINE_END = String.raw`(?=[ \t]*(?:$|\r|\\[nr]|"))`;
// A one-line value: double-, single- or JSON-escaped-double-quoted, or bare.
const LINE_VALUE = String.raw`"[^"\\\r\n]*"|'[^'\\\r\n]*'|\\"[^"\\\r\n]*\\"|[^\s"'\\]+`;

/**
 * Line-anchored INI/TOML `key = value` (`aws_secret_access_key = …` in
 * ~/.aws/credentials). Spaces around `=` are only accepted here, where the
 * key starts the line, so `const password = getPassword()` stays intact.
 */
const INI_ASSIGNMENT_RE = new RegExp(
  String.raw`${LINE_START}([ \t]*)([A-Za-z_][\w.]*)([ \t]*=[ \t]*)(${LINE_VALUE})${LINE_END}`,
  "gm",
);

/** Line-anchored YAML `key: value`, including list items (`- token: …`). */
const YAML_KEY_RE = new RegExp(
  String.raw`${LINE_START}([ \t]*(?:-[ \t]+)?)([A-Za-z_][\w.-]*)([ \t]*:[ \t]+)(${LINE_VALUE})${LINE_END}`,
  "gm",
);

function redactLineValue(
  match: string,
  lead: string,
  key: string,
  sep: string,
  value: string,
): string {
  if (!isSensitiveKeyPath(key)) return match;
  const quote = /^(?:\\"|"|')/.exec(value)?.[0] ?? "";
  const inner = quote ? value.slice(quote.length, -quote.length) : value;
  if (isPlaceholderValue(inner) || (!quote && looksLikeCode(inner))) return match;
  return `${lead}${key}${sep}${quote}[REDACTED:${key}]${quote}`;
}

const JSON_KEY = String.raw`[A-Za-z_][\w.-]{0,63}`;
/**
 * The opening of `"key": "value"`, raw or JSON-escaped inside a session-log
 * string (`\"key\":\"value\"`). Only string values are redacted. The value
 * itself is walked by `jsonStringEnd`, not by the regex: a backtracking value
 * pattern costs ~100 ms on a 200 KB unterminated value.
 */
const JSON_KEY_RE = new RegExp(String.raw`"(${JSON_KEY})"[ \t]*:[ \t]*"`, "g");
const ESCAPED_JSON_KEY_RE = new RegExp(String.raw`\\"(${JSON_KEY})\\"[ \t]*:[ \t]*\\"`, "g");

/**
 * Index of the quote token that closes the JSON string body starting at
 * `start`. If the line ends first, returns `-(stop + 1)` where `stop` is the
 * index the walk halted at, so the caller can resume past it. Escapes are
 * consumed whole, so a PEM with `\n` escapes ends at its real closing quote.
 * With `escaped`, the body is itself JSON-escaped: each `\x` pair is one inner
 * character, and the close is an inner `"` (the pair `\"`) not preceded by an
 * inner `\`.
 */
function jsonStringEnd(text: string, start: number, escaped: boolean): number {
  let innerEscape = false;
  for (let i = start; i < text.length; i++) {
    let ch = text[i];
    if (ch === "\r" || ch === "\n") return -(i + 1);
    const at = i;
    if (escaped) {
      if (ch === '"') return -(i + 1);
      if (ch === "\\") {
        ch = text[++i];
        if (ch === undefined || ch === "\r" || ch === "\n") return -(i + 1);
        if (ch !== "\\" && ch !== '"') ch = "x";
      }
    }
    if (innerEscape) innerEscape = false;
    else if (ch === "\\") innerEscape = true;
    else if (ch === '"') return at;
  }
  return -(text.length + 1);
}

function redactJsonValues(text: string, re: RegExp, escaped: boolean): string {
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const key = m[1] ?? "";
    if (!isSensitiveKeyPath(key)) continue;
    const valueStart = m.index + m[0].length;
    const end = jsonStringEnd(text, valueStart, escaped);
    if (end < 0) {
      // Resume where the walk stopped so no span is walked twice. Back off one
      // character: an escaped walk stops on the bare `"` of a `\"` opener.
      re.lastIndex = Math.max(re.lastIndex, -end - 2);
      continue;
    }
    re.lastIndex = end + 1;
    if (isPlaceholderValue(text.slice(valueStart, end))) continue;
    out += `${text.slice(last, valueStart)}[REDACTED:${key}]`;
    last = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

// An RFC 7235 token68 credential, as carried by Authorization headers.
// It must end the run, so a fragment glued to a marker (`x-[REDACTED:…]`) is skipped.
const TOKEN68 = String.raw`[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9._~+/=\[-])`;
// `Header: ` in raw, JSON (`"Header": "`), escaped JSON and curl `-H '…'` forms.
const HEADER_SEP = String.raw`\\?["']?[ \t]*:[ \t]*\\?["']?`;

/** `Authorization: Bearer <cred>`; the scheme survives redaction. */
const AUTH_HEADER_RE = new RegExp(
  String.raw`(?<![\w-])((?:proxy-)?authorization)(${HEADER_SEP}(?:bearer|basic|token|bot)[ \t]+)(${TOKEN68})`,
  "gi",
);
const API_KEY_HEADER_RE = new RegExp(
  String.raw`(?<![\w-])(x-api-key)(${HEADER_SEP})(${TOKEN68})`,
  "gi",
);

function redactHeader(match: string, name: string, sep: string, value: string): string {
  if (/^[A-Za-z_]+$/.test(value) && value.length < 16) return match; // a prose word
  return `${name}${sep}[REDACTED:${name.toLowerCase().replace(/-/g, "_")}]`;
}

/** curl `--password <pw>` and `-u|--user|-U|--proxy-user user:<pw>`. */
const CURL_PASSWORD_RE = /(?<=^|[\s'"])(--password(?:[ \t]+|=)\\?["']?)([^\s"'\\]+)/g;
const CURL_USER_RE =
  /(?<=^|[\s'"])((?:-u|-U|--user|--proxy-user)(?:[ \t]+|=)\\?["']?([^\s"'\\:@]+):)([^\s"'\\@]+)/g;

/** A curl user flag, the only text `CURL_USER_RE` can match in. */
const CURL_USER_FLAG_RE = /(?:^|\s)-(?:u|U|-user|-proxy-user)\b/;

/** `scheme://user:<pw>@host`: only the password goes, the host survives. */
const URL_USERINFO_RE =
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@?#"'\\]+:)([^\s/@?#"'\\]+)(?=@)/gi;

/**
 * PEM private-key blocks, raw or with literal `\n` escapes. The body cannot
 * contain `-----`, so a missing END marker costs one scan to the next dash
 * run, and the 16 KB cap bounds even that.
 */
const PEM_RE =
  /(-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?-----)((?:(?!-----)[\s\S]){1,16384})(-----END [A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?-----)/g;
const PEM_MARKER = "[REDACTED:private_key]";

/**
 * Pass 4: credentials identified by their context (a sensitive JSON/YAML
 * key, an auth header, a curl flag, URL userinfo, PEM armor) rather than by a
 * vendor prefix. Every rule skips a value that is already redacted, so the
 * pass is idempotent.
 */
function scrubKeyContext(text: string): string {
  let out = text;
  if (out.includes("PRIVATE KEY")) {
    out = out.replace(PEM_RE, (match, begin: string, body: string, end: string) =>
      body === PEM_MARKER ? match : `${begin}${PEM_MARKER}${end}`,
    );
  }
  if (/authorization|x-api-key/i.test(out)) {
    out = out.replace(AUTH_HEADER_RE, redactHeader).replace(API_KEY_HEADER_RE, redactHeader);
  }
  if (out.includes("--password")) {
    out = out.replace(CURL_PASSWORD_RE, (match, flag: string, pw: string) =>
      isPlaceholderValue(pw) ? match : `${flag}[REDACTED:curl_password]`,
    );
  }
  if (CURL_USER_FLAG_RE.test(out)) {
    out = out.replace(CURL_USER_RE, (match, prefix: string, user: string, pw: string) =>
      // `-u 1000:1000` / `-u node:node` is a docker uid:gid, not a credential.
      isPlaceholderValue(pw) || pw === user ? match : `${prefix}[REDACTED:curl_password]`,
    );
  }
  if (out.includes("://")) {
    out = out.replace(URL_USERINFO_RE, (match, prefix: string, pw: string) =>
      isPlaceholderValue(pw) ? match : `${prefix}[REDACTED:url_password]`,
    );
  }
  if (out.includes('"')) {
    out = redactJsonValues(out, JSON_KEY_RE, false);
    if (out.includes('\\"')) out = redactJsonValues(out, ESCAPED_JSON_KEY_RE, true);
  }
  if (out.includes(":")) out = out.replace(YAML_KEY_RE, redactLineValue);
  return out;
}

/**
 * Structural regex patterns for common credential shapes. Applied AFTER the
 * env-value substitution pass so env-sourced replacements keep their
 * human-readable `[REDACTED:<KEY_NAME>]` labels instead of the generic
 * pattern name.
 *
 * Order matters when one pattern is a prefix of another (e.g. `sk-ant-` must
 * match before the more general `sk-`).
 *
 * `lits` are literals of which every match of `re` contains one, in any
 * letter case. The boot sweep's `mayRedact` skips a rule whose literals do not
 * occur, so a rule's literals must be a necessary part of its match (the corpus
 * test checks each rule against its own matches).
 */

// Leading word boundary that also matches after JSON escape sequences (\n, \t,
// \r, etc.) where the trailing char is alphanumeric and defeats standard \b.
const TB = String.raw`(?:(?<=\\[nrtbfu0])|(?<!\w))`;
// Rules whose token class includes `-` end on `(?!\w)`, not `\b`: a token
// ending in `-` has no word boundary after it, so `\b` backtracks and leaves
// the last character behind.

/** A Convex deployment name, team slug or project slug. */
const CONVEX_SLUG = "[a-z0-9][a-z0-9-]{0,63}";

const TOKEN_REGEXES: ReadonlyArray<{ name: string; lits: string[]; re: RegExp }> = [
  // GitHub fine-grained PATs
  { name: "github_pat", lits: ["github_pat_"], re: /github_pat_[A-Za-z0-9_]{20,}/g },
  // GitHub classic/OAuth tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  {
    name: "github_token",
    lits: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
    re: new RegExp(String.raw`${TB}gh[pousr]_[A-Za-z0-9]{20,}\b`, "g"),
  },
  // ACP ephemeral session tokens (base62 payload)
  {
    name: "acp_session_token",
    lits: ["aseph_"],
    re: new RegExp(String.raw`${TB}aseph_[A-Za-z0-9]{20,}\b`, "g"),
  },
  // GitLab personal access tokens
  {
    name: "gitlab_pat",
    lits: ["glpat-"],
    re: new RegExp(String.raw`${TB}glpat-[A-Za-z0-9_-]{20,}(?!\w)`, "g"),
  },
  // Azure DevOps personal access tokens (84 chars, "AZDO" signature at offset 76)
  {
    name: "azure_devops_pat",
    lits: ["AZDO"],
    re: new RegExp(String.raw`${TB}[A-Za-z0-9]{76}AZDO[A-Za-z0-9]{4}\b`, "g"),
  },
  // Anthropic API keys (must match before the generic sk- rule below)
  {
    name: "anthropic_key",
    lits: ["sk-ant-"],
    re: new RegExp(String.raw`${TB}sk-ant-[A-Za-z0-9_-]{20,}(?!\w)`, "g"),
  },
  // OpenAI project keys
  {
    name: "openai_proj_key",
    lits: ["sk-proj-"],
    re: new RegExp(String.raw`${TB}sk-proj-[A-Za-z0-9_-]{20,}(?!\w)`, "g"),
  },
  // OpenRouter keys
  {
    name: "openrouter_key",
    lits: ["sk-or-"],
    re: new RegExp(String.raw`${TB}sk-or-(?:v1-)?[A-Za-z0-9_-]{20,}(?!\w)`, "g"),
  },
  // Generic sk- legacy OpenAI keys (must come AFTER the ant/proj/or variants)
  {
    name: "sk_key",
    lits: ["sk-"],
    re: new RegExp(String.raw`${TB}sk-[A-Za-z0-9]{20,}\b`, "g"),
  },
  // Slack tokens
  {
    name: "slack_token",
    lits: ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-", "xoxe-", "xoxo-"],
    re: new RegExp(String.raw`${TB}xox[baprseo]-[A-Za-z0-9-]{10,}(?!\w)`, "g"),
  },
  // AWS access key IDs
  {
    name: "aws_access_key",
    lits: ["AKIA"],
    re: new RegExp(String.raw`${TB}AKIA[0-9A-Z]{16}\b`, "g"),
  },
  // Google API keys
  {
    name: "google_api_key",
    lits: ["AIza"],
    re: new RegExp(String.raw`${TB}AIza[A-Za-z0-9_-]{35}(?!\w)`, "g"),
  },
  // JWTs (3 dot-separated base64url segments)
  {
    name: "jwt",
    lits: ["eyJ"],
    re: new RegExp(
      String.raw`${TB}eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?!\w)`,
      "g",
    ),
  },
  // SigNoz Cloud OTLP auth header values.
  {
    name: "signoz_ingestion_key",
    lits: ["signoz-ingestion-key="],
    re: new RegExp(String.raw`${TB}signoz-ingestion-key=[A-Za-z0-9._~+/-]{20,}={0,2}\b`, "g"),
  },
  // Linear OAuth tokens and API keys
  {
    name: "linear_oauth",
    lits: ["lin_oauth_"],
    re: new RegExp(String.raw`${TB}lin_oauth_[A-Za-z0-9_-]{10,}(?!\w)`, "g"),
  },
  {
    name: "linear_api",
    lits: ["lin_api_"],
    re: new RegExp(String.raw`${TB}lin_api_[A-Za-z0-9_-]{10,}(?!\w)`, "g"),
  },
  // npm tokens
  {
    name: "npm_token",
    lits: ["npm_"],
    re: new RegExp(String.raw`${TB}npm_[A-Za-z0-9_-]{20,}(?!\w)`, "g"),
  },
  // Jira API tokens (Atlassian cloud)
  {
    name: "atlassian_token",
    lits: ["ATATT"],
    re: new RegExp(String.raw`${TB}ATATT[A-Za-z0-9_=-]{20,}(?![\w=])`, "g"),
  },
  // Agent-swarm MCP user tokens (`aswt_<base62-20+>`). Schema lands in
  // migration 064; mint/revoke endpoints ship with the MCP-token plan.
  // Rule lives here now so plaintexts never leak into logs once endpoints
  // come online.
  {
    name: "mcp_token",
    lits: ["aswt_"],
    re: new RegExp(String.raw`${TB}aswt_[A-Za-z0-9]{20,}\b`, "g"),
  },
  // Vendor shapes the gitleaks rule set (pass 5) has no rule for.
  // Resend API keys: re_<8>_<24>, with a digit and an uppercase letter so
  // snake_case identifiers never match.
  {
    name: "resend_key",
    lits: ["re_"],
    re: new RegExp(
      String.raw`${TB}re_(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9]{8}_[A-Za-z0-9]{24}\b`,
      "g",
    ),
  },
  // Google OAuth access tokens and refresh tokens
  {
    name: "google_oauth_token",
    lits: ["ya29."],
    re: new RegExp(String.raw`${TB}ya29\.[A-Za-z0-9_-]{20,}`, "g"),
  },
  {
    name: "google_refresh_token",
    lits: ["1//0"],
    re: /(?<![\w/])1\/\/0[A-Za-z0-9_-]{30,}/g,
  },
  // Discord webhook URLs (the token is the last path segment)
  {
    name: "discord_webhook",
    lits: ["/api/webhooks/"],
    re: /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{50,}/g,
  },
  // xAI API keys
  {
    name: "xai_key",
    lits: ["xai-"],
    re: new RegExp(String.raw`${TB}xai-[A-Za-z0-9]{40,}\b`, "g"),
  },
  // Telegram bot tokens without a "telegram" keyword nearby: <bot id>:AA<33>
  {
    name: "telegram_bot_token",
    lits: [":AA"],
    re: new RegExp(String.raw`${TB}\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])`, "g"),
  },
  // Convex deploy keys and project tokens (docs.convex.dev/cli/deploy-key-types):
  // `prod:<deployment>|<token>`, `dev:<deployment>|<token>`,
  // `preview:<team>:<project>|<token>`, `project:<team>:<project>|<token>`.
  // The `|` often arrives URL-encoded as `%7C`, and the base64 token's `+`, `/`
  // and `=` as `%2B`, `%2F` and `%3D`. The 20-char token floor keeps prose
  // (`prod: done`) and short URL params (`q=dev:a%7Cb`) out.
  {
    name: "convex_deploy_key",
    lits: ["prod:", "dev:", "preview:", "project:"],
    re: new RegExp(
      String.raw`${TB}(?:(?:prod|dev):${CONVEX_SLUG}|(?:preview|project):${CONVEX_SLUG}:${CONVEX_SLUG})(?:\||%7[Cc])(?:[A-Za-z0-9+/_-]|%2[BbFf]){20,}(?:=|%3[Dd]){0,2}`,
      "g",
    ),
  },
];

/**
 * Pass 5: the vendored gitleaks rule set (src/utils/secret-rules.generated.ts).
 * Compiled on first use. A rule runs only when the text contains one of its
 * keywords, and a match counts only when its secret clears the rule's entropy
 * floor and no allowlist claims it, the same gates gitleaks applies.
 */
interface CompiledAllowlist {
  target: "secret" | "match";
  res: RegExp[];
  stopwords: string[];
}

interface CompiledGitleaksRule {
  id: string;
  re: RegExp;
  keywords: string[];
  entropy?: number;
  secretGroup?: number;
  redactWholeMatch?: boolean;
  allowlists: CompiledAllowlist[];
}

interface CompiledGitleaks {
  /** Every keyword in one case-insensitive, longest-first alternation. */
  keywordRe: RegExp;
  /** keyword -> every keyword it contains, itself included. */
  implied: Map<string, string[]>;
  rules: CompiledGitleaksRule[];
  global: CompiledAllowlist;
}

let gitleaks: CompiledGitleaks | null = null;

function getGitleaks(): CompiledGitleaks {
  if (gitleaks) return gitleaks;
  const compile = (r: { source: string; flags: string }) => new RegExp(r.source, r.flags);
  const rules = GITLEAKS_RULES.rules.map((rule) => ({
    id: rule.id,
    re: new RegExp(rule.source, `${rule.flags}gd`),
    keywords: rule.keywords,
    entropy: rule.entropy,
    secretGroup: rule.secretGroup,
    redactWholeMatch: rule.redactWholeMatch,
    allowlists: (rule.allowlists ?? []).map((list) => ({
      target: list.target,
      res: list.regexes.map(compile),
      stopwords: list.stopwords,
    })),
  }));
  const keywords = [...new Set(rules.flatMap((rule) => rule.keywords))].sort(
    (a, b) => b.length - a.length,
  );
  gitleaks = {
    keywordRe: new RegExp(keywords.map(escapeRegExp).join("|"), "gi"),
    implied: new Map(keywords.map((k) => [k, keywords.filter((other) => k.includes(other))])),
    rules,
    global: {
      target: "secret",
      res: GITLEAKS_RULES.globalAllowlist.regexes.map(compile),
      stopwords: GITLEAKS_RULES.globalAllowlist.stopwords,
    },
  };
  return gitleaks;
}

/** Shannon entropy in bits per character, as gitleaks computes it. */
function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function allowedBy(list: CompiledAllowlist, secret: string, match: string): boolean {
  const target = list.target === "match" ? match : secret;
  if (list.res.some((re) => re.test(target))) return true;
  if (list.stopwords.length === 0) return false;
  const lower = secret.toLowerCase();
  return list.stopwords.some((word) => lower.includes(word));
}

/** Secret spans `[start, end)` a rule redacts in `text`, after its entropy and allowlist gates. */
function* gitleaksSecretSpans(
  text: string,
  rule: CompiledGitleaksRule,
  global: CompiledAllowlist,
): Generator<[number, number]> {
  const { re } = rule;
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    // gitleaks' secret: the configured group, else the first non-empty group,
    // else the whole match. Only the secret is redacted; the context stays.
    let group = 0;
    if (rule.secretGroup && m[rule.secretGroup]) group = rule.secretGroup;
    else if (!rule.redactWholeMatch && !rule.secretGroup) {
      group = m.findIndex((g, i) => i > 0 && !!g);
      if (group === -1) group = 0;
    }
    const secret = m[group] as string;
    const span = m.indices?.[group];
    if (!span) continue;
    // Resume at the end of the secret, not the match. Many rules consume a
    // delimiter on each side, so `a b` shares one space: resuming after it
    // hides the second secret's leading boundary. The next match starts at or
    // after span[1], so redacted spans never overlap; the max keeps progress.
    re.lastIndex = Math.max(span[1], m.index + 1);
    if (rule.entropy && shannonEntropy(secret) <= rule.entropy) continue;
    if (allowedBy(global, secret, m[0])) continue;
    if (rule.allowlists.some((list) => allowedBy(list, secret, m[0]))) continue;
    yield [span[0], span[1]];
  }
}

function applyGitleaksRule(text: string, rule: CompiledGitleaksRule, global: CompiledAllowlist) {
  let out = "";
  let last = 0;
  let changed = false;
  for (const [start, end] of gitleaksSecretSpans(text, rule, global)) {
    out += `${text.slice(last, start)}[REDACTED:gitleaks:${rule.id}]`;
    last = end;
    changed = true;
  }
  return changed ? out + text.slice(last) : text;
}

let gitleaksPassEnabled = true;

/** Test-only: switch pass 5 off to measure what it costs. */
export function setGitleaksPassEnabledForTesting(enabled: boolean): void {
  gitleaksPassEnabled = enabled;
}

/** The gitleaks rules whose keywords appear in `text` (empty when pass 5 is off). */
function activeGitleaksRules(text: string): CompiledGitleaksRule[] {
  if (!gitleaksPassEnabled) return [];
  const { keywordRe, implied, rules } = getGitleaks();
  // Visit every start position that has a keyword. The alternation is
  // longest-first, so a shorter keyword starting at the same position is a
  // substring of the one found, and `implied` adds it.
  const present = new Set<string>();
  keywordRe.lastIndex = 0;
  for (let m = keywordRe.exec(text); m !== null; m = keywordRe.exec(text)) {
    for (const keyword of implied.get(m[0].toLowerCase()) ?? []) present.add(keyword);
    keywordRe.lastIndex = m.index + 1;
  }
  if (present.size === 0) return [];
  return rules.filter((rule) => rule.keywords.some((keyword) => present.has(keyword)));
}

function scrubGitleaks(text: string): string {
  let out = text;
  for (const rule of activeGitleaksRules(text)) {
    out = applyGitleaksRule(out, rule, getGitleaks().global);
  }
  return out;
}

type VendorSpan = { start: number; end: number; id: string };
type Edit = { start: number; end: number; len: number };

/**
 * Gitleaks spans shared by the pass 2 rules of one scrub call. The sweep runs
 * at most once per call, on the first structural hit; each rule then moves the
 * spans through its own edits instead of sweeping its output again.
 */
type VendorSpanCache = { spans: VendorSpan[] | null };

let pass2SweepCount = 0;

/** Test-only: how many pass 2 gitleaks sweeps ran since the last call. */
export function takePass2SweepCountForTesting(): number {
  const n = pass2SweepCount;
  pass2SweepCount = 0;
  return n;
}

function vendorSpansOf(text: string, cache: VendorSpanCache): VendorSpan[] {
  if (cache.spans === null) {
    pass2SweepCount++;
    const { global } = getGitleaks();
    cache.spans = activeGitleaksRules(text).flatMap((rule) =>
      [...gitleaksSecretSpans(text, rule, global)].map(([s, e]) => ({
        start: s,
        end: e,
        id: rule.id,
      })),
    );
  }
  return cache.spans;
}

/**
 * Moves spans through sorted, non-overlapping edits. A span an edit touches
 * is dropped: its secret was redacted or cut, and pass 5 still sweeps the
 * final text for anything a fresh sweep would have found.
 */
function shiftSpans(spans: VendorSpan[], edits: Edit[]): VendorSpan[] {
  if (edits.length === 0 || spans.length === 0) return spans;
  const out: VendorSpan[] = [];
  let i = 0;
  let delta = 0;
  for (const v of [...spans].sort((x, y) => x.start - y.start)) {
    let e = edits[i];
    while (e && e.end <= v.start) {
      delta += e.len - (e.end - e.start);
      e = edits[++i];
    }
    if (e && e.start < v.end) continue;
    out.push({ start: v.start + delta, end: v.end + delta, id: v.id });
  }
  return out;
}

/** `text.replace(re, marker)` that also returns the edits it made. */
function replaceAll(text: string, re: RegExp, marker: string): { out: string; edits: Edit[] } {
  const edits: Edit[] = [];
  const out = text.replace(re, (match: string, ...rest: unknown[]) => {
    const start = rest.find((x) => typeof x === "number") as number;
    edits.push({ start, end: start + match.length, len: marker.length });
    return marker;
  });
  return { out, edits };
}

/**
 * Pass 2 for one structural rule. A gitleaks secret that strictly contains a
 * hit wins (longest span): it is redacted whole first, so a generic rule
 * matching inside it (`sk-…` in a Heroku key's tail) cannot leave its prefix
 * behind for pass 5 to miss.
 */
function applyTokenRegex(text: string, name: string, re: RegExp, cache: VendorSpanCache): string {
  const marker = `[REDACTED:${name}]`;
  const covering: VendorSpan[] = [];
  const edits: Edit[] = [];
  const out = text.replace(re, (match: string, ...rest: unknown[]) => {
    const start = rest.find((x) => typeof x === "number") as number;
    const end = start + match.length;
    let best: VendorSpan | undefined;
    for (const v of vendorSpansOf(text, cache)) {
      if (v.start <= start && end <= v.end && v.end - v.start > match.length) {
        if (!best || v.end - v.start > best.end - best.start) best = v;
      }
    }
    if (!best) {
      edits.push({ start, end, len: marker.length });
      return marker;
    }
    covering.push(best);
    return match;
  });
  if (covering.length === 0) {
    if (cache.spans) cache.spans = shiftSpans(cache.spans, edits);
    return out;
  }
  // Redact the covering secrets right to left, longest first on a tie; one
  // that overlaps the marker to its right merges into that marker.
  covering.sort((x, y) => y.start - x.start || y.end - x.end);
  let result = text;
  let floor = Number.POSITIVE_INFINITY;
  const vendorEdits: Edit[] = [];
  for (const v of covering) {
    if (v.start >= floor) continue;
    const end = Math.min(v.end, floor);
    const vendorMarker = v.end > floor ? "" : `[REDACTED:gitleaks:${v.id}]`;
    result = result.slice(0, v.start) + vendorMarker + result.slice(end);
    vendorEdits.push({ start: v.start, end, len: vendorMarker.length });
    floor = v.start;
  }
  const structural = replaceAll(result, re, marker);
  cache.spans = shiftSpans(shiftSpans(cache.spans ?? [], vendorEdits.reverse()), structural.edits);
  return structural.out;
}

interface EnvValueEntry {
  value: string;
  name: string;
}

interface ScrubCache {
  entries: EnvValueEntry[];
  snapshotKey: string;
}

/**
 * Pass 1 matcher: every known value (env entries + volatile secrets) in one
 * alternation regex, longest value first, so each scrub is a single scan no
 * matter how many values are registered.
 */
interface KnownValueMatcher {
  /** null when there is nothing to match, or the regex could not be built. */
  re: RegExp | null;
  /** value -> marker name. */
  names: Map<string, string>;
  /** Longest-first values, used only when `re` failed to build. */
  fallback: string[];
  /** Inputs the matcher was built from; a change on either rebuilds it. */
  builtFor: ScrubCache;
  builtAtGeneration: number;
}

let cache: ScrubCache | null = null;
let matcher: KnownValueMatcher | null = null;
const volatileSecrets = new Map<string, string>();
/** Bumped whenever `volatileSecrets` changes, so the matcher rebuilds lazily. */
let volatileGeneration = 0;
/** Key names marked secret at runtime (swarm_config rows with isSecret=1). */
const registeredSensitiveKeys = new Set<string>();

/** Fingerprint current env so we can invalidate cache cheaply when it changes. */
function snapshotEnv(): string {
  const parts: string[] = [];
  for (const key of Object.keys(process.env).sort()) {
    if (!isSensitiveKey(key)) continue;
    const v = process.env[key];
    if (!v) continue;
    parts.push(`${key}=${v.length}`);
  }
  return parts.join("|");
}

/**
 * Memoized verdicts. Every scrub call re-checks every env key, and log text
 * repeats the same JSON/YAML keys, so the normalization runs once per name.
 * Bounded because log text can carry arbitrary key names; cleared whenever
 * the registered key set changes.
 */
const sensitiveKeyVerdicts = new Map<string, boolean>();
const MAX_KEY_VERDICTS = 4096;

export function isSensitiveKey(key: string): boolean {
  const cached = sensitiveKeyVerdicts.get(key);
  if (cached !== undefined) return cached;
  const verdict = computeIsSensitiveKey(key);
  if (sensitiveKeyVerdicts.size >= MAX_KEY_VERDICTS) sensitiveKeyVerdicts.clear();
  sensitiveKeyVerdicts.set(key, verdict);
  return verdict;
}

function computeIsSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (NON_SECRET_EXCEPTIONS.has(normalized)) return false;
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
  if (registeredSensitiveKeys.has(key) || registeredSensitiveKeys.has(normalized)) return true;
  for (const suffix of SENSITIVE_KEY_SUFFIXES) {
    if (normalized.endsWith(suffix)) return true;
  }
  // Codex OAuth pool credentials: codex_oauth (legacy) + codex_oauth_0…N (pool slots).
  // The outer JSON structure (accountId, expires) isn't covered by TOKEN_REGEXES.
  if (/^codex_oauth(_\d+)?$/.test(key)) return true;
  return false;
}

/**
 * Every form of a credential value a consumer may send: the raw value, its
 * trimmed form, and each trimmed member of a comma pool. `selectCredential`
 * trims the key it hands out, so a padded singleton reaches the provider (and
 * its error echo) without the padding.
 */
function credentialCandidates(value: string): string[] {
  const candidates = new Set([value, value.trim()]);
  if (value.includes(",")) {
    for (const member of value.split(",")) candidates.add(member.trim());
  }
  candidates.delete("");
  return [...candidates];
}

function buildCache(): ScrubCache {
  const entries: EnvValueEntry[] = [];
  const seen = new Set<string>();

  for (const [key, rawValue] of Object.entries(process.env)) {
    if (!rawValue) continue;
    if (!isSensitiveKey(key)) continue;

    for (const candidate of credentialCandidates(rawValue)) {
      if (candidate.length < MIN_VALUE_LENGTH) continue;
      for (const form of escapedForms(candidate)) {
        if (seen.has(form)) continue;
        seen.add(form);
        entries.push({ value: form, name: key });
      }
    }
  }

  // Replace longer values before shorter ones so prefix-overlapping secrets
  // don't mangle each other (rare but possible with pool values).
  entries.sort((a, b) => b.value.length - a.value.length);

  return { entries, snapshotKey: snapshotEnv() };
}

function getCache(): ScrubCache {
  const current = snapshotEnv();
  if (!cache || cache.snapshotKey !== current) {
    cache = buildCache();
  }
  return cache;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(envCache: ScrubCache): KnownValueMatcher {
  // Volatile names first, env names second: when a value is both, the env
  // name wins, as it did when the env pass ran before the volatile pass.
  const names = new Map<string, string>(volatileSecrets);
  for (const { value, name } of envCache.entries) names.set(value, name);

  // Longest first: a regex alternation takes the first alternative that
  // matches at a position, so a value that is a prefix of a longer one must
  // come after it or the longer value would be cut in half.
  const values = [...names.keys()].sort((a, b) => b.length - a.length);
  let re: RegExp | null = null;
  if (values.length > 0) {
    try {
      re = new RegExp(values.map(escapeRegExp).join("|"), "g");
    } catch {
      // Pattern too large for the engine: fall back to the per-value loop.
      re = null;
    }
  }
  return {
    re,
    names,
    fallback: re ? [] : values,
    builtFor: envCache,
    builtAtGeneration: volatileGeneration,
  };
}

function getMatcher(): KnownValueMatcher {
  const envCache = getCache();
  if (
    !matcher ||
    matcher.builtFor !== envCache ||
    matcher.builtAtGeneration !== volatileGeneration
  ) {
    matcher = buildMatcher(envCache);
  }
  return matcher;
}

/**
 * A string that has passed through `scrubSecrets`. Still a plain `string` at
 * runtime; the brand lets a DB writer demand scrubbed input so `tsc` rejects a
 * raw string. Only `scrubSecrets` produces it.
 */
export type ScrubbedText = string & { readonly __scrubbed: true };

/**
 * Replace known secret values in `text` with `[REDACTED:<name>]` markers.
 * Null/undefined inputs return an empty string. Empty strings pass through.
 */
export function scrubSecrets(text: string | null | undefined): ScrubbedText {
  if (text == null) return "" as ScrubbedText;
  if (text.length === 0) return text as ScrubbedText;
  return scrubWithMatcher(text, getMatcher());
}

function scrubWithMatcher(text: string, matcher: KnownValueMatcher): ScrubbedText {
  let out = text;

  // Pass 1: exact-match known values, env first then volatile (registered at
  // runtime, incl. every stored secret the API's secret registry loads). The
  // marker keeps the env-var / source name for debugging.
  const { re, names, fallback } = matcher;
  if (re) {
    re.lastIndex = 0;
    out = out.replace(re, (match) => `[REDACTED:${names.get(match) ?? "secret"}]`);
  } else {
    for (const value of fallback) {
      if (out.includes(value)) out = out.split(value).join(`[REDACTED:${names.get(value)}]`);
    }
  }

  // Pass 2: structural patterns (catches secrets we never saw in env, e.g.
  // a token pasted into a tool_result by the operator or fetched from a
  // third-party API during a task).
  const vendorSpans: VendorSpanCache = { spans: null };
  for (const { name, re } of TOKEN_REGEXES) out = applyTokenRegex(out, name, re, vendorSpans);

  // Passes 3 and 4: values of sensitive `KEY=value` assignments (env dumps,
  // .env files, shell traces), including ones too short for pass 1, and
  // credentials known by their context (JSON/YAML keys, auth headers, curl
  // flags, URL userinfo, PEM blocks).
  out = scrubKeyPasses(out);

  // Pass 5: vendor token shapes from the gitleaks rule set, behind a keyword
  // prefilter and each rule's entropy floor.
  return scrubGitleaks(out) as ScrubbedText;
}

/**
 * Boot-sweep gate. `mayRedact(text)` is false only when `scrubSecrets(text)`
 * would return `text` unchanged, so the sweep can skip those rows and run the
 * full scrub on the rest. Each clause is a necessary condition of one pass, and
 * the last of each is the pass itself, minus the rewrite:
 *   1. a known value occurs (the pass-1 matcher);
 *   2. a structural rule's literal occurs and its regex matches;
 *   3-4. a key-context trigger occurs (PRIVATE KEY, an auth header, a curl
 *      flag, URL userinfo, or a sensitive key name before `=`, `:` or a quote)
 *      and passes 3 and 4 then change the text;
 *   5. a gitleaks rule yields a span (same keyword gate and span walk).
 * With every clause false no pass edits `text`, so each pass sees the original.
 * A new pass or trigger in `scrubSecrets` needs a clause here.
 */
const DIRECT_KEY_TRIGGERS = ["private key", "authorization", "x-api-key", "--password"];
/** Triggers that need a second check: a curl `-u`, and a URL (`://`) with userinfo (`@`). */
const KEY_TRIGGER_LITERALS = [...DIRECT_KEY_TRIGGERS, "-u", "://", "@"];

/** Longest prefix of a known value the gate looks for; `re` then confirms the whole value. */
const VALUE_PREFIX_LENGTH = 12;

interface SweepMatchers {
  /** Gitleaks keywords, structural rule literals, key triggers and known-value prefixes, in one pass. */
  literals: LiteralMatcher;
  /** Scratch for `literals.collect`. */
  found: Uint8Array;
  /** False when a known value has no usable ASCII prefix: only the matcher itself can clear it. */
  valuesGated: boolean;
}

let sweepRules: {
  keywords: string[];
  keywordRules: CompiledGitleaksRule[][];
  ruleLiterals: string[];
  literalRules: Array<Array<(typeof TOKEN_REGEXES)[number]>>;
} | null = null;

function getSweepRules() {
  if (sweepRules) return sweepRules;
  const { rules } = getGitleaks();
  const keywords = [...new Set(rules.flatMap((rule) => rule.keywords))];
  const ruleLiterals = [...new Set(TOKEN_REGEXES.flatMap((rule) => rule.lits))];
  sweepRules = {
    keywords,
    keywordRules: keywords.map((keyword) =>
      rules.filter((rule) => rule.keywords.includes(keyword)),
    ),
    ruleLiterals,
    literalRules: ruleLiterals.map((lit) =>
      TOKEN_REGEXES.filter((rule) => rule.lits.includes(lit)),
    ),
  };
  return sweepRules;
}

const sweepMatchers = new WeakMap<KnownValueMatcher, SweepMatchers>();

/** The one-pass literal matcher for the current known values (rebuilt when they change). */
function getSweepMatchers(matcher: KnownValueMatcher): SweepMatchers {
  const cached = sweepMatchers.get(matcher);
  if (cached) return cached;
  const { keywords, ruleLiterals } = getSweepRules();
  // A value that occurs starts with its prefix, so a prefix is a necessary condition.
  const prefixes = new Set<string>();
  let valuesGated = true;
  for (const value of matcher.names.keys()) {
    const ascii = /^[^\u0080-\uffff]*/.exec(value)?.[0] ?? "";
    const prefix = ascii.slice(0, VALUE_PREFIX_LENGTH);
    if (prefix.length < 4) valuesGated = false;
    else prefixes.add(prefix);
  }
  const patterns = [...keywords, ...ruleLiterals, ...KEY_TRIGGER_LITERALS, ...prefixes];
  const built = {
    literals: new LiteralMatcher(patterns),
    found: new Uint8Array(patterns.length),
    valuesGated,
  };
  sweepMatchers.set(matcher, built);
  return built;
}

let keyNeedles: LiteralMatcher | null = null;

/**
 * Matches a sensitive key name right before `=`, `:`, a space, a tab, a quote
 * or a backslash, where the key-context regexes end a key. `normalizeKey` only
 * upper-cases and adds `_`, so `isSensitiveKey` accepts a key only when, with
 * `_ . -` dropped, it ends with a suffix or is an exact name, a registered name
 * or `codex_oauth` (each with `_ . -` dropped too). The matcher skips those
 * characters in the text, so it also reads `to-ken` as `token`: a superset.
 */
function sensitiveKeyNeedles(): LiteralMatcher {
  if (keyNeedles) return keyNeedles;
  const strip = (name: string) => name.toUpperCase().replace(/[_.-]/g, "");
  const all = [...SENSITIVE_KEY_SUFFIXES, ...SENSITIVE_KEY_EXACT, ...registeredSensitiveKeys].map(
    strip,
  );
  const names = all
    // A key is ASCII, so a name with other characters can never equal one.
    .filter((name) => /^[A-Z0-9]+$/.test(name));
  // An ending that another name ends with already covers the longer name.
  const needles = [...new Set(names)].filter(
    (name) => !names.some((other) => other !== name && name.endsWith(other)),
  );
  // `codex_oauth_<n>` is sensitive too, so a digit also ends that key. No other
  // name covers it (a suffix like `OAUTH` ends before the digit), so it skips the dedupe.
  const codexOauth = "CODEXOAUTH";
  const ends = [...'=: \t"\\'];
  // A name of only `_ . -` strips to "": its key is the bare name, so any end can follow.
  const bare = all.includes("") ? ends : [];
  keyNeedles = new LiteralMatcher(
    [
      ...needles.flatMap((needle) => ends.map((end) => needle + end)),
      ...[...ends, ..."0123456789"].map((end) => codexOauth + end),
      ...bare,
    ],
    { skip: "_.-" },
  );
  return keyNeedles;
}

/** Passes 3 and 4 of `scrubSecrets`: key-context credentials. */
function scrubKeyPasses(text: string): string {
  let out = text.replace(ASSIGNMENT_RE, redactAssignment);
  if (out.includes("=")) out = out.replace(INI_ASSIGNMENT_RE, redactLineValue);
  return scrubKeyContext(out);
}

function mayRedactWith(text: string, matcher: KnownValueMatcher): boolean {
  if (text.length === 0) return false;
  const { keywordRules, literalRules, keywords, ruleLiterals } = getSweepRules();
  const sweep = getSweepMatchers(matcher);
  const found = sweep.found.fill(0);
  sweep.literals.collect(text, found);
  const ruleBase = keywords.length;
  const triggerBase = ruleBase + ruleLiterals.length;
  const valueBase = triggerBase + KEY_TRIGGER_LITERALS.length;

  // Pass 1: a known value's prefix occurs, and the matcher then finds the value.
  const { re, fallback } = matcher;
  if (!sweep.valuesGated || found.indexOf(1, valueBase) !== -1) {
    if (re) {
      re.lastIndex = 0;
      if (re.test(text)) return true;
    } else if (fallback.some((value) => text.includes(value))) return true;
  }

  // Pass 2: a literal of a structural rule occurs, and the rule's regex then matches.
  for (let id = ruleBase; id < triggerBase; id++) {
    if (!found[id]) continue;
    for (const rule of literalRules[id - ruleBase] ?? []) {
      rule.re.lastIndex = 0;
      if (rule.re.test(text)) return true;
    }
  }

  // Passes 3 and 4: a trigger occurs, and the key passes then change the text.
  const [user, url, at] = [4, 5, 6].map((i) => found[triggerBase + i]);
  const keyTrigger =
    DIRECT_KEY_TRIGGERS.some((_, i) => found[triggerBase + i]) ||
    (user && CURL_USER_FLAG_RE.test(text)) ||
    (url && at);
  if ((keyTrigger || sensitiveKeyNeedles().has(text)) && scrubKeyPasses(text) !== text) {
    return true;
  }

  // Pass 5: a gitleaks rule whose keyword occurs yields a span.
  const { global } = getGitleaks();
  const active = new Set<CompiledGitleaksRule>();
  for (let id = 0; id < ruleBase; id++) {
    if (found[id]) for (const rule of keywordRules[id] ?? []) active.add(rule);
  }
  for (const rule of active) if (!gitleaksSecretSpans(text, rule, global).next().done) return true;
  return false;
}

/**
 * `scrubSecrets` for a sweep: one call per time slice, then call the result per
 * text. It resolves the known-value matcher once, where `scrubSecrets` re-reads
 * the environment on every call, and returns a text `mayRedact` clears as is.
 * Valid until the event loop next turns: a secret registered in between needs a
 * fresh one.
 */
export function createSweepScrubber(): (text: string) => string {
  const matcher = getMatcher();
  return (text) => (mayRedactWith(text, matcher) ? scrubWithMatcher(text, matcher) : text);
}

let rulesFingerprint: string | null = null;

/**
 * A short hash of the rule tables (structural and gitleaks rules, key names and
 * the key-context regexes). The boot sweep records it with a skipped rules
 * version, so an operator can tell which rule set a forward-only install never
 * backfilled. Coverage itself is keyed by `SCRUBBER_RULES_VERSION`.
 */
export function scrubberRulesFingerprint(): string {
  if (rulesFingerprint) return rulesFingerprint;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify([
      TOKEN_REGEXES.map((rule) => [rule.name, rule.re.source, rule.re.flags]),
      GITLEAKS_RULES,
      SENSITIVE_KEY_SUFFIXES,
      [...SENSITIVE_KEY_EXACT],
      [
        ASSIGNMENT_RE,
        INI_ASSIGNMENT_RE,
        YAML_KEY_RE,
        JSON_KEY_RE,
        ESCAPED_JSON_KEY_RE,
        AUTH_HEADER_RE,
        API_KEY_HEADER_RE,
        CURL_PASSWORD_RE,
        CURL_USER_RE,
        URL_USERINFO_RE,
        PEM_RE,
      ].map((re) => re.source),
    ]),
  );
  rulesFingerprint = hasher.digest("hex").slice(0, 16);
  return rulesFingerprint;
}

/** Test-only: the structural rules, to check each rule's `lits` against its own matches. */
export const tokenRulesForTesting = TOKEN_REGEXES;

/** Test-only: the sweep gate on its own. */
export function mayRedactForTesting(text: string): boolean {
  return mayRedactWith(text, getMatcher());
}

/** What `findSecretsIn` found: names and rule ids only, never the values. */
export interface SecretFindings {
  /** Names of known values (env + registered secrets, every encoded form). */
  knownValues: string[];
  /** Ids of gitleaks rules whose pattern matched. */
  gitleaksRules: string[];
}

/**
 * Detect, without redacting, the two secret classes a write must refuse
 * outright: a known value (pass 1, every form it was registered in) and a
 * gitleaks vendor-token rule (pass 5). The key-context passes are left out on
 * purpose: on code they flag `password: "…"`-shaped literals that are often
 * not secrets.
 */
export function findSecretsIn(text: string): SecretFindings {
  const knownValues = new Set<string>();
  const gitleaksRules = new Set<string>();
  if (text.length === 0) return { knownValues: [], gitleaksRules: [] };

  const { re, names, fallback } = getMatcher();
  if (re) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      knownValues.add(names.get(m[0]) ?? "secret");
    }
  } else {
    for (const value of fallback) {
      if (text.includes(value)) knownValues.add(names.get(value) ?? "secret");
    }
  }

  for (const rule of activeGitleaksRules(text)) {
    if (applyGitleaksRule(text, rule, getGitleaks().global) !== text) gitleaksRules.add(rule.id);
  }

  return { knownValues: [...knownValues].sort(), gitleaksRules: [...gitleaksRules].sort() };
}

export function scrubObject<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubSecrets(value) as T;
  if (typeof value !== "object") return value;

  if (seen.has(value)) {
    return "[Circular]" as T;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubObject(item, seen)) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = scrubObject(child, seen);
  }
  return out as T;
}

export type ValueScrubber = {
  text(text: string): string;
  object<T>(value: T): T;
};

/**
 * Redact exact occurrences of the given values, at any length, in one output
 * boundary that knows which secrets it handed out (a script run's secret
 * config). The global passes above keep their MIN_VALUE_LENGTH floor; this
 * one never registers anything swarm-wide. All forms match in a single regex
 * pass, longest first, so one value's marker is never rewritten by another
 * value's pass. Object keys are redacted too.
 */
export function createValueScrubber(
  entries: Array<{ value: string; name: string }>,
): ValueScrubber {
  const names = new Map<string, string>();
  for (const { value, name } of entries) {
    if (!value) continue;
    for (const form of escapedForms(value)) if (!names.has(form)) names.set(form, name);
  }
  if (names.size === 0) return { text: (text) => text, object: (value) => value };

  const pattern = [...names.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const re = new RegExp(pattern, "g");
  const text = (input: string) =>
    input.replace(re, (match) => `[REDACTED:${names.get(match) ?? "secret"}]`);
  const object = <T>(value: T, seen = new WeakSet<object>()): T => {
    if (typeof value === "string") return text(value) as T;
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]" as T;
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => object(item, seen)) as T;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        text(key),
        object(child, seen),
      ]),
    ) as T;
  };
  return { text, object: (value) => object(value) };
}

/**
 * Force the env-value cache to rebuild on the next scrub call. Callers should
 * invoke this whenever the swarm_config is reloaded (`/internal/reload-config`
 * on the API, credential-selection on the worker) so new secrets get covered
 * immediately.
 */
export function refreshSecretScrubberCache(): void {
  cache = null;
}

/**
 * Register a runtime-fetched secret that is not present in process.env.
 *
 * Use this before returning short-lived tokens through an API/tool result so
 * follow-on logs, telemetry previews, and session-log egress can redact the
 * concrete value even though the caller still receives it.
 */
export function registerVolatileSecret(value: string, name: string): void {
  if (value.length < MIN_VALUE_LENGTH) return;
  for (const form of escapedForms(value)) {
    if (volatileSecrets.get(form) === name) continue;
    volatileSecrets.set(form, name);
    volatileGeneration++;
  }
}

/**
 * Register the sensitive values of an env map that is not `process.env`
 * (a runner's per-task env, an adapter's session env). A key picked from a
 * credential pool, or a row admitted after boot, lives only there, so the
 * env pass never sees it. Comma-separated pools register each member too,
 * and padded values register their trimmed form.
 */
export function registerEnvSecrets(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value || !isSensitiveKey(key)) continue;
    for (const candidate of credentialCandidates(value)) registerVolatileSecret(candidate, key);
  }
}

/** Remove a short-lived secret and its encoded forms after credential revocation. */
export function unregisterVolatileSecret(name: string): void {
  for (const [value, registeredName] of volatileSecrets) {
    if (registeredName !== name) continue;
    volatileSecrets.delete(value);
    volatileGeneration++;
  }
}

/**
 * Mark a key name as sensitive at runtime (a swarm_config row with
 * isSecret=1 whose name matches no suffix rule). Its process.env value joins
 * the exact-match pass, and `KEY=value` assignments of it are redacted at any
 * value length.
 */
export function registerSensitiveKeyName(key: string): void {
  if (registeredSensitiveKeys.has(key)) return;
  registeredSensitiveKeys.add(key);
  sensitiveKeyVerdicts.clear();
  keyNeedles = null;
  cache = null;
}

/** Test-only: drop volatile values and runtime-registered key names. */
export function clearVolatileSecretsForTesting(): void {
  volatileSecrets.clear();
  volatileGeneration++;
  matcher = null;
  registeredSensitiveKeys.clear();
  sensitiveKeyVerdicts.clear();
  keyNeedles = null;
  cache = null;
}
