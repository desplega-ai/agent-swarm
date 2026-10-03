/**
 * PreToolUse guard: block `gh pr create` / `gh pr edit` when the PR title or
 * body for a PUBLIC repo carries internal identifiers (see
 * `src/utils/pr-body-leaks.ts`).
 *
 * Shared by the Claude hook (`hook.ts`) and the codex hook (`codex-hook.ts`).
 * The block reason names leak categories only, never the matched text.
 *
 * What gets scanned: the resolved title and body, not the whole command.
 *   - `--title` / `--body` values (any flag form: `-b"x"`, `--body=x`, ...).
 *   - `--body-file PATH`, read relative to the `cd` target.
 *   - `--body-file -` fed by a heredoc, here-string or `< PATH`.
 *   - `--body-file -` fed by a pipe, or a body the shell builds from an
 *     unquoted `$(...)`: the guard cannot isolate the text, so it scans the
 *     whole command instead.
 *
 * Which repo: `--repo` / `-R` in any position (also before `pr`), the PR URL
 * given to `gh pr edit` (after expanding `$VAR` / `${VAR}`), `GH_REPO`, else
 * the checkout at the `cd` target. Every explicit target is checked; any
 * public one blocks.
 *
 * Failure modes:
 *   - Text scanned clean: allow without a visibility lookup.
 *   - Text has leaks, or `--body-file` is unreadable: look up the repo
 *     visibility. PUBLIC blocks; PRIVATE / INTERNAL allows.
 *   - Visibility lookup fails, a `cd` target cannot be resolved (`cd -`,
 *     unset variable), or a `gh pr edit` target is neither a PR number, a
 *     branch nor a PR URL (unset variable, `$(...)`): block (fail closed). We
 *     already know the body is unsafe or unreadable, and we cannot prove the
 *     repo is private. An unknown edit target never falls back to the checkout.
 *   - Body comes from an unexpanded shell variable (`--body "$BODY"`): the
 *     guard cannot see it and allows (fail open). CI still checks the body.
 */

import { isAbsolute, resolve } from "node:path";
import { findPrBodyLeaks, type LeakCategory } from "../utils/pr-body-leaks";

export type GhPrInvocation = {
  /** Working directory of the `gh` call after any `cd`; null when a `cd` target could not be resolved. */
  cwd: string | null;
  /** Explicit target repos: `--repo` / `-R`, a PR URL, or `GH_REPO`. Empty means the checkout at `cwd`. */
  repos: string[];
  /** The `gh pr edit` target could not be classified (unset variable, `$(...)`, non-PR URL), so the PR's repo is unknown. */
  unknownTarget: boolean;
  /** Literal public text: `--title` and `--body` values, heredoc or here-string stdin. */
  texts: string[];
  /** Files that become the body: `--body-file PATH`, or `--body-file -` with `< PATH`. */
  bodyFiles: string[];
  /** The body text could not be isolated (piped stdin, unquoted `$(...)`); scan the whole command. */
  opaqueBody: boolean;
};

export type PrBodyGuardDeps = {
  readFile: (path: string) => Promise<string>;
  /** Returns GitHub's `visibility` (PUBLIC, PRIVATE, INTERNAL). Throws when the lookup fails. */
  repoVisibility: (target: { cwd: string; repo?: string }) => Promise<string>;
  env: Record<string, string | undefined>;
};

/** One simple command: its words, plus any heredoc / here-string text fed to its stdin. */
export type ShellSegment = { words: string[]; stdin: string[] };

const SEPARATORS = ["&&", "||", ";", "|", "&", "\n", "(", ")"];
const COMMAND_WRAPPERS = new Set(["env", "command", "exec", "time", "sudo", "nohup"]);

/**
 * Split a shell command into simple commands. Handles quotes, backslashes,
 * comments, heredocs and here-strings, not expansions.
 */
export function tokenizeShell(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [{ words: [], stdin: [] }];
  const current = () => segments[segments.length - 1] as ShellSegment;
  const heredocs: Array<{ delimiter: string; stripTabs: boolean; segment: ShellSegment }> = [];
  let hereString = false;
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (inWord) {
      if (hereString) current().stdin.push(word);
      else current().words.push(word);
      hereString = false;
    }
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (
        ch === "\\" &&
        i + 1 < command.length &&
        '"\\$`'.includes(command[i + 1] as string)
      ) {
        word += command[++i];
      } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") {
        word += command[i + 1];
        inWord = true;
      }
      i++;
      continue;
    }
    if (ch === "#" && !inWord) {
      // Comment: skip to the end of the line, keep the newline.
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (command.startsWith("<<<", i)) {
      push();
      hereString = true;
      i += 2;
      continue;
    }
    if (command.startsWith("<<", i)) {
      push();
      let j = i + 2;
      const stripTabs = command[j] === "-";
      if (stripTabs) j++;
      while (command[j] === " " || command[j] === "\t") j++;
      let delimiter = "";
      while (j < command.length && !/[\s;&|()<>]/.test(command[j] as string)) {
        if (!"'\"\\".includes(command[j] as string)) delimiter += command[j];
        j++;
      }
      if (delimiter) heredocs.push({ delimiter, stripTabs, segment: current() });
      i = j - 1;
      continue;
    }
    if (ch === "\n" && heredocs.length > 0) {
      // Heredoc bodies start on the next line, in the order they were opened.
      push();
      let j = i + 1;
      for (const doc of heredocs) {
        const lines: string[] = [];
        while (j < command.length) {
          const newline = command.indexOf("\n", j);
          const lineEnd = newline === -1 ? command.length : newline;
          const line = command.slice(j, lineEnd);
          j = lineEnd + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
          lines.push(line);
        }
        doc.segment.stdin.push(lines.join("\n"));
      }
      heredocs.length = 0;
      segments.push({ words: [], stdin: [] });
      i = j - 1;
      continue;
    }
    const sep = SEPARATORS.find((s) => command.startsWith(s, i));
    if (sep) {
      push();
      segments.push({ words: [], stdin: [] });
      i += sep.length - 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      push();
      continue;
    }
    word += ch;
    inWord = true;
  }
  push();
  for (const doc of heredocs) doc.segment.stdin.push("");
  return segments.filter((s) => s.words.length > 0);
}

/** Expand `~`, `$VAR` and `${VAR}`. Returns null when a variable is unset. */
function expandPath(path: string, env: Record<string, string | undefined>): string | null {
  let unresolved = false;
  const expanded = path
    .replace(/^~(?=\/|$)/, env.HOME ?? "~")
    .replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced: string | undefined, bare: string | undefined) => {
      const value = env[(braced ?? bare) as string];
      if (value === undefined) unresolved = true;
      return value ?? "";
    });
  return unresolved ? null : expanded;
}

/** Value-taking flags of `gh` and `gh pr create|edit`, keyed by long name. Others are boolean. */
const VALUE_FLAGS = new Set([
  "repo",
  "body",
  "body-file",
  "title",
  "base",
  "head",
  "assignee",
  "label",
  "milestone",
  "project",
  "reviewer",
  "template",
  "recover",
  "add-assignee",
  "add-label",
  "add-project",
  "add-reviewer",
  "remove-assignee",
  "remove-label",
  "remove-project",
  "remove-reviewer",
]);
const SHORT_FLAGS: Record<string, string> = {
  R: "repo",
  b: "body",
  F: "body-file",
  t: "title",
  B: "base",
  H: "head",
  a: "assignee",
  l: "label",
  m: "milestone",
  p: "project",
  r: "reviewer",
  T: "template",
};

type ParsedArgs = {
  positionals: string[];
  flags: Array<[name: string, value: string]>;
  /** `< PATH` stdin redirect. */
  stdinFile?: string;
};

/**
 * Parse `gh` arguments the way pflag does: `--name value`, `--name=value`,
 * `-x value`, `-xvalue`, `-x=value`, and boolean clusters such as `-dF body.md`.
 */
function parseGhArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const redirect = /^\d*(<|>>?|>\|)(&?)(.*)$/.exec(arg);
    if (redirect) {
      const target = redirect[3] || (args[++i] ?? "");
      if (redirect[1] === "<" && !redirect[2]) parsed.stdinFile = target;
      continue;
    }
    if (arg === "--") {
      parsed.positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      if (eq !== -1) parsed.flags.push([name, arg.slice(eq + 1)]);
      else parsed.flags.push([name, VALUE_FLAGS.has(name) ? (args[++i] ?? "") : ""]);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let k = 1; k < arg.length; k++) {
        const name = SHORT_FLAGS[arg[k] as string] ?? (arg[k] as string);
        if (!VALUE_FLAGS.has(name)) {
          parsed.flags.push([name, ""]);
          continue;
        }
        const attached = arg.slice(k + 1).replace(/^=/, "");
        parsed.flags.push([name, k + 1 < arg.length ? attached : (args[++i] ?? "")]);
        break;
      }
      continue;
    }
    parsed.positionals.push(arg);
  }
  return parsed;
}

/** `OWNER/REPO` (or `HOST/OWNER/REPO`) from a PR URL, else undefined. */
function repoFromPrUrl(target: string | undefined): string | undefined {
  const match = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(target ?? "");
  if (!match) return undefined;
  const [, host, owner, name] = match;
  return host === "github.com" ? `${owner}/${name}` : `${host}/${owner}/${name}`;
}

type EditTarget = { kind: "local" } | { kind: "url"; repo: string } | { kind: "unknown" };

/**
 * Classify the positional target of `gh pr edit` after expanding `$VAR` /
 * `${VAR}`. No target, a PR number or a branch name resolve in the checkout
 * (or `-R` repo); a PR URL names its own repo. Anything else (an unset
 * variable, command substitution, a non-PR URL) is unknown.
 */
function classifyEditTarget(
  target: string | undefined,
  env: Record<string, string | undefined>,
): EditTarget {
  if (target === undefined) return { kind: "local" };
  if (target.includes("`") || target.includes("$(")) return { kind: "unknown" };
  const expanded = expandPath(target, env);
  if (expanded === null) return { kind: "unknown" };
  const repo = repoFromPrUrl(expanded);
  if (repo) return { kind: "url", repo };
  if (/^#?\d+$/.test(expanded)) return { kind: "local" };
  if (/^[\w.+@:/-]+$/.test(expanded) && !expanded.startsWith("-") && !expanded.includes("://")) {
    return { kind: "local" };
  }
  return { kind: "unknown" };
}

/** Find every `gh pr create|edit` call in a shell command. */
export function parseGhPrCommands(
  command: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): GhPrInvocation[] {
  const found: GhPrInvocation[] = [];
  const shellEnv = { ...env };
  let dir: string | null = cwd;
  for (const { words, stdin } of tokenizeShell(command)) {
    if (words[0] === "cd" || words[0] === "pushd") {
      const operands = words.slice(1);
      while (operands[0] !== undefined && /^-[LPe@]+$/.test(operands[0])) operands.shift();
      if (operands[0] === "--") operands.shift();
      if (operands.length > 1) continue; // bash: too many arguments, cd fails
      const operand = operands[0] ?? shellEnv.HOME ?? "~";
      const target = operand === "-" ? null : expandPath(operand, shellEnv);
      dir = target === null || dir === null ? null : resolve(dir, target);
      if (target !== null && isAbsolute(target)) dir = target;
      continue;
    }
    if (words[0] === "popd") {
      dir = null;
      continue;
    }
    if (words[0] === "export") {
      for (const assignment of words.slice(1)) {
        const eq = assignment.indexOf("=");
        if (eq > 0) shellEnv[assignment.slice(0, eq)] = assignment.slice(eq + 1);
      }
      continue;
    }
    // `gh` must be the command word: only env assignments or wrappers may precede it.
    const gh = words.findIndex((w) => !/^\w+=/.test(w) && !COMMAND_WRAPPERS.has(w));
    const word = words[gh] ?? "";
    if (!(word === "gh" || word.endsWith("/gh"))) continue;
    const args = parseGhArgs(words.slice(gh + 1));
    const [group, action, target] = args.positionals;
    if (group !== "pr" || (action !== "create" && action !== "edit")) continue;

    const values = (...names: string[]) =>
      args.flags.filter(([name]) => names.includes(name)).map(([, value]) => value);
    const prefixRepo = words
      .slice(0, gh)
      .find((w) => w.startsWith("GH_REPO="))
      ?.slice("GH_REPO=".length);
    const editTarget: EditTarget =
      action === "edit" ? classifyEditTarget(target, shellEnv) : { kind: "local" };
    let repos = [...values("repo"), ...(editTarget.kind === "url" ? [editTarget.repo] : [])];
    if (repos.length === 0 && (prefixRepo ?? shellEnv.GH_REPO)) {
      repos = [(prefixRepo ?? shellEnv.GH_REPO) as string];
    }

    const inline = values("title", "body");
    const bodyFiles = values("body-file").filter((file) => file !== "-");
    const fromStdin = values("body-file").includes("-");
    if (fromStdin && args.stdinFile !== undefined) bodyFiles.push(args.stdinFile);
    found.push({
      cwd: dir,
      repos: [...new Set(repos)],
      unknownTarget: editTarget.kind === "unknown",
      texts: [...inline, ...(fromStdin ? stdin : [])],
      bodyFiles,
      // An unquoted `$(` splits at the paren, leaving a value that ends in `$`.
      // In the edit target, it also cuts every later flag off this segment.
      opaqueBody:
        inline.some((value) => value.endsWith("$")) ||
        (action === "edit" && target?.endsWith("$") === true) ||
        (fromStdin && stdin.length === 0 && args.stdinFile === undefined),
    });
  }
  return found;
}

const BLOCK_ADVICE =
  "Paraphrase the motivation ('a maintainer asked for X') and link only public sources (Fixes #N, a public PR or issue). Internal provenance stays in the swarm task.";

/** Check a shell command. Returns a block reason, or null to allow. */
export async function checkGhPrCommand(
  command: string,
  cwd: string,
  deps: PrBodyGuardDeps,
): Promise<string | null> {
  if (!/\bgh\b[\s\S]*\bpr\b/.test(command)) return null;
  for (const call of parseGhPrCommands(command, cwd, deps.env)) {
    const leaks = new Set<LeakCategory>();
    for (const text of call.opaqueBody ? [...call.texts, command] : call.texts) {
      for (const leak of findPrBodyLeaks(text)) leaks.add(leak);
    }
    let unreadable: string | undefined;
    for (const bodyFile of call.bodyFiles) {
      const expanded = expandPath(bodyFile, deps.env);
      try {
        if (expanded === null) throw new Error("unset variable");
        const base = isAbsolute(expanded) ? "/" : call.cwd;
        if (base === null) throw new Error("unknown working directory");
        for (const leak of findPrBodyLeaks(await deps.readFile(resolve(base, expanded)))) {
          leaks.add(leak);
        }
      } catch {
        unreadable ??= bodyFile;
      }
    }
    if (leaks.size === 0 && unreadable === undefined) continue;

    // An unknown edit target never falls back to the checkout: its repo is unknown.
    const targets: Array<string | undefined | null> = call.unknownTarget
      ? [null]
      : call.repos.length > 0
        ? call.repos
        : [undefined];
    for (const repo of targets) {
      let visibility = "UNKNOWN";
      if (repo !== null && (repo !== undefined || call.cwd !== null)) {
        try {
          visibility = (await deps.repoVisibility({ cwd: call.cwd ?? cwd, repo })).trim();
        } catch {
          visibility = "UNKNOWN";
        }
      }
      if (visibility === "PRIVATE" || visibility === "INTERNAL") continue;

      const where =
        repo === null
          ? "a gh pr edit target that could not be resolved"
          : visibility === "PUBLIC"
            ? "this public repo"
            : "a repo whose visibility could not be confirmed";
      if (leaks.size > 0) {
        return `PR body leak check: the PR body for ${where} contains internal identifiers (${[...leaks].join(", ")}). ${BLOCK_ADVICE}`;
      }
      return `PR body leak check: could not read --body-file ${unreadable} for ${where}, so the body was not checked. Pass a literal path to a file that exists.`;
    }
  }
  return null;
}

/** Real dependencies: the filesystem and `gh repo view`. */
export const defaultPrBodyGuardDeps = (
  env: Record<string, string | undefined> = process.env,
): PrBodyGuardDeps => ({
  env,
  readFile: (path) => Bun.file(path).text(),
  repoVisibility: async ({ cwd, repo }) => {
    const proc = Bun.spawn(
      [
        "gh",
        "repo",
        "view",
        ...(repo ? [repo] : []),
        "--json",
        "visibility",
        "--jq",
        ".visibility",
      ],
      { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    const timer = setTimeout(() => proc.kill(), 10_000);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) throw new Error(`gh repo view exited ${code}`);
      return out.trim();
    } finally {
      clearTimeout(timer);
    }
  },
});

/** The shell command of a Bash-like tool call, or null. Accepts a string or an argv array. */
export function shellCommandOf(toolInput: unknown): string | null {
  const command = (toolInput as { command?: unknown } | undefined)?.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    // ["bash", "-lc", "<script>"] -> the script; any other argv -> joined words.
    if (command.length >= 3 && /^-\w*c$/.test(command[1] as string)) {
      return command[command.length - 1] as string;
    }
    return command.join(" ");
  }
  return null;
}

/**
 * Entry point for both hooks. Returns a block reason or null. Never throws:
 * an internal error allows the call (fail open), so a guard bug cannot halt
 * every Bash call. CI's PR Body check is the backstop.
 */
export async function guardGhPrBody(
  toolInput: unknown,
  cwd: string,
  deps: PrBodyGuardDeps = defaultPrBodyGuardDeps(),
): Promise<string | null> {
  try {
    const command = shellCommandOf(toolInput);
    return command === null ? null : await checkGhPrCommand(command, cwd, deps);
  } catch {
    return null;
  }
}
