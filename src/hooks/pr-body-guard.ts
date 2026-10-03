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
 * public one blocks. Variables come from the hook env and the command itself
 * (assignments, `export`, `unset`, subshells, `bash -c`, `eval`); where the
 * parser cannot follow the shell, the variable is unknown (see
 * `parseGhPrCommands`).
 *
 * Failure modes:
 *   - Text scanned clean: allow without a visibility lookup.
 *   - Text has leaks, or `--body-file` is unreadable: look up the repo
 *     visibility. PUBLIC blocks; PRIVATE / INTERNAL allows.
 *   - Visibility lookup fails, a `cd` target cannot be resolved (`cd -`,
 *     unset or unknown variable, a `cd` that may not have run), a `gh pr edit` target is neither a PR
 *     number, a branch nor a PR URL (unset or unknown variable, `$(...)`), or
 *     `GH_REPO` is unknown: block (fail closed). We
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
  /** Also check the checkout: `GH_REPO` was assigned without `export`, so gh may not see it. */
  alsoCheckout: boolean;
  /** The `gh pr edit` target could not be classified (unset variable, `$(...)`, non-PR URL), so the PR's repo is unknown. */
  unknownTarget: boolean;
  /** Literal public text: `--title` and `--body` values, heredoc or here-string stdin. */
  texts: string[];
  /** Files that become the body, expanded: `--body-file PATH`, or `--body-file -` with `< PATH`. */
  bodyFiles: string[];
  /** Body file paths whose variables could not be resolved, as written. They count as unreadable. */
  unresolvedBodyFiles: string[];
  /** The body text could not be isolated (piped stdin, unquoted `$(...)`); scan the whole command. */
  opaqueBody: boolean;
};

export type PrBodyGuardDeps = {
  readFile: (path: string) => Promise<string>;
  /** Returns GitHub's `visibility` (PUBLIC, PRIVATE, INTERNAL). Throws when the lookup fails. */
  repoVisibility: (target: { cwd: string; repo?: string }) => Promise<string>;
  env: Record<string, string | undefined>;
};

/**
 * One simple command: its words, plus any heredoc / here-string text fed to its
 * stdin. `depth` counts the open `(` before it (subshells and `$(`); it goes
 * negative on an unmatched `)` (a `case` pattern). `async` marks a pipeline
 * member or a member of a `&` background list, which runs in a subshell.
 * `ops` lists the separators between the previous command and this one.
 */
export type ShellSegment = {
  words: string[];
  stdin: string[];
  depth: number;
  async: boolean;
  ops: string[];
};

const SEPARATORS = ["&&", "||", ";", "|", "&", "\n", "(", ")"];
const COMMAND_WRAPPERS = new Set(["env", "command", "exec", "time", "sudo", "nohup"]);

/**
 * Split a shell command into simple commands. Handles quotes, backslashes,
 * comments, heredocs and here-strings, not expansions.
 */
export function tokenizeShell(command: string): ShellSegment[] {
  let depth = 0;
  const segments: ShellSegment[] = [{ words: [], stdin: [], depth, async: false, ops: [] }];
  const current = () => segments[segments.length - 1] as ShellSegment;
  // First segment of the current list, per `(` level: a `&` backgrounds all of it.
  const listStarts = [0];
  // After `&&`, `||` or `|`, a newline continues the list.
  let continued = false;
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
      continued = false;
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
      segments.push({ words: [], stdin: [], depth, async: false, ops: ["\n"] });
      if (!continued) listStarts[listStarts.length - 1] = segments.length - 1;
      i = j - 1;
      continue;
    }
    const sep = SEPARATORS.find((s) => command.startsWith(s, i));
    if (sep) {
      push();
      if (sep === "|") current().async = true;
      if (sep === "&") {
        // `a && b &` runs the whole and-or list in the background.
        for (let k = listStarts[listStarts.length - 1] as number; k < segments.length; k++) {
          (segments[k] as ShellSegment).async = true;
        }
      }
      if (sep === "(") depth++;
      if (sep === ")") depth--;
      segments.push({ words: [], stdin: [], depth, async: sep === "|", ops: [sep] });
      if (sep === "(") listStarts.push(segments.length - 1);
      else if (sep === ")") {
        if (listStarts.length > 1) listStarts.pop();
      } else if (sep === ";" || sep === "&" || (sep === "\n" && !continued)) {
        listStarts[listStarts.length - 1] = segments.length - 1;
      }
      continued = sep === "&&" || sep === "||" || sep === "|" || (sep === "\n" && continued);
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
  // Drop empty segments; their separators belong to the next command.
  let ops: string[] = [];
  return segments.filter((s) => {
    ops.push(...s.ops);
    if (s.words.length === 0) return false;
    s.ops = ops;
    ops = [];
    return true;
  });
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
  expand: (word: string) => string | null,
): EditTarget {
  if (target === undefined) return { kind: "local" };
  if (target.includes("`") || target.includes("$(")) return { kind: "unknown" };
  const expanded = expand(target);
  if (expanded === null) return { kind: "unknown" };
  const repo = repoFromPrUrl(expanded);
  if (repo) return { kind: "url", repo };
  if (/^#?\d+$/.test(expanded)) return { kind: "local" };
  if (/^[\w.+@:/-]+$/.test(expanded) && !expanded.startsWith("-") && !expanded.includes("://")) {
    return { kind: "local" };
  }
  return { kind: "unknown" };
}

type FrameKind = "top" | "paren" | "if" | "loop" | "case" | "brace";
/** A variable or the working directory, changed by a command the parser applied. */
type Write = { name: string } | { dir: true };
/**
 * A list context: the whole command, a `( ... )`, or a compound command
 * (`if`, a loop, `case`, `{ ... }`).
 */
type Frame = {
  kind: FrameKind;
  /** The operator before the current element of the and-or list. */
  tail: "none" | "and" | "or";
  /** Writes applied by `&&` elements of the current and-or list. */
  list: Write[];
  /** Writes applied inside this compound command (this branch, for `if` and `case`). */
  block: Write[];
};
const newFrame = (kind: FrameKind): Frame => ({ kind, tail: "none", list: [], block: [] });
const isCompound = (frame: Frame) => frame.kind !== "top" && frame.kind !== "paren";

type ReservedWords = {
  /** Index of the first word after the leading reserved words. */
  start: number;
  /** Compound commands opened (by kind), branched (`else`, `elif`) or closed, in order. */
  actions: Array<FrameKind | "branch" | "close">;
  /** `function NAME`. */
  functionKeyword: boolean;
};

/** Read the reserved words that lead a simple command (`if gh ...`, `then X=1`, `fi`). */
function scanReservedWords(words: string[]): ReservedWords {
  const actions: ReservedWords["actions"] = [];
  let functionKeyword = false;
  let k = 0;
  for (; k < words.length; k++) {
    const word = words[k] as string;
    if (word === "if") actions.push("if");
    else if (word === "while" || word === "until") actions.push("loop");
    else if (word === "{") actions.push("brace");
    else if (word === "else" || word === "elif") actions.push("branch");
    else if (word === "fi" || word === "done" || word === "esac" || word === "}") {
      actions.push("close");
    } else if (word === "function" && k + 1 < words.length) {
      functionKeyword = true;
      k++; // the name
    } else if (word !== "then" && word !== "do" && word !== "!") break;
  }
  // `for`, `select` and `case` take a header: the rest of this segment.
  if (words[k] === "for" || words[k] === "select") actions.push("loop");
  if (words[k] === "case") actions.push("case");
  return { start: k, actions, functionKeyword };
}

/** For each segment that opens a loop, the index of the segment that closes it. */
function loopEnds(segments: ShellSegment[]): Array<number | undefined> {
  const ends: Array<number | undefined> = [];
  const open: Array<{ kind: FrameKind; index: number }> = [];
  segments.forEach((segment, index) => {
    for (const action of scanReservedWords(segment.words).actions) {
      if (action === "close") {
        const opened = open.pop();
        if (opened?.kind === "loop") ends[opened.index] = index;
      } else if (action !== "branch") open.push({ kind: action, index });
    }
  });
  for (const opened of open) {
    if (opened.kind === "loop") ends[opened.index] = segments.length - 1;
  }
  return ends;
}

/**
 * Commands that change variables in ways the parser does not model. After one,
 * every variable expansion in the command is unknown.
 */
const UNMODELED_VARIABLE_COMMANDS = new Set([
  "read",
  "source",
  ".",
  "eval",
  "declare",
  "typeset",
  "local",
  "readonly",
  "mapfile",
  "readarray",
  "getopts",
  "let",
  "case",
]);
/** POSIX special builtins. In POSIX mode, assignments that precede one persist. */
const SPECIAL_BUILTINS = new Set([
  ":",
  ".",
  "break",
  "continue",
  "eval",
  "exec",
  "exit",
  "export",
  "readonly",
  "return",
  "set",
  "shift",
  "times",
  "trap",
  "unset",
]);
/** `NAME=value`, `NAME+=value` or `NAME[i]=value`. */
const ASSIGNMENT = /^([A-Za-z_]\w*)(\[[^\]]*\])?(\+?)=([\s\S]*)$/;

type ShellState = {
  env: Record<string, string | undefined>;
  exported: Set<string>;
  unknownVars: Set<string>;
  dir: string | null;
};

/**
 * Find every `gh pr create|edit` call in a shell command.
 *
 * The parser follows the shell variables and working directory that decide a
 * call's target and body file. Where it cannot follow the shell, it marks a
 * variable (or every variable) unknown instead of guessing, so a target or body
 * file that uses one fails closed:
 *   - `NAME=value` alone or in `export` sets the variable. A value with `$`, a
 *     backtick or `~` makes it unknown, as does `NAME+=` or `NAME[i]=`.
 *   - The parser does not know which commands run. A write (assignment,
 *     `export`, `unset`, `cd`) counts only for the commands that run only if
 *     it ran: the later `&&` elements of its and-or list, and the rest of its
 *     compound command branch. After that, the variable (or directory) is
 *     unknown until a write that always runs. A write after `||` is unknown at
 *     once. A loop body is read twice: its writes are unknown from its start.
 *   - A write in a pipeline member or a `&` list makes the variable (or
 *     directory) unknown. Leaving a `( ... )` subshell restores the variables
 *     and directory from before it.
 *   - A function definition makes every later expansion and the directory
 *     unknown: a call can run its body anywhere after it.
 *   - `read`, `source`, `.`, `eval`, `declare`, `typeset`, `local`,
 *     `readonly`, `mapfile`, `readarray`, `getopts`, `let`, `case`,
 *     `printf -v`, `export` with a flag, or a backtick outside a `gh` call
 *     make every later expansion unknown. `for NAME` and `${NAME:=x}` make
 *     NAME unknown.
 */
export function parseGhPrCommands(
  command: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): GhPrInvocation[] {
  return parseWithState(
    command,
    {
      env: { ...env },
      exported: new Set(Object.keys(env).filter((name) => env[name] !== undefined)),
      unknownVars: new Set(),
      dir: cwd,
    },
    { allUnknown: false, dirUnknown: false },
  );
}

/** Set for the rest of a command: every expansion, or the working directory, is unknown. */
type UnknownFlags = { allUnknown: boolean; dirUnknown: boolean };

const copyState = (s: ShellState): ShellState => ({
  env: { ...s.env },
  exported: new Set(s.exported),
  unknownVars: new Set(s.unknownVars),
  dir: s.dir,
});
const copyFrame = (f: Frame): Frame => ({ ...f, list: [...f.list], block: [...f.block] });
const isGhWord = (word: string | undefined) => word === "gh" || word?.endsWith("/gh") === true;
const isShellWord = (word: string | undefined) => /(^|\/)(ba|da|k|z)?sh$/.test(word ?? "");

function parseWithState(
  command: string,
  initial: ShellState,
  initialFlags: UnknownFlags,
): GhPrInvocation[] {
  const found: GhPrInvocation[] = [];
  let state = initial;
  let { allUnknown, dirUnknown } = initialFlags;
  const scopes: ShellState[] = [];
  let frames: Frame[] = [newFrame("top")];
  const top = () => frames[frames.length - 1] as Frame;
  const copy = copyState;

  /** Expand `~`, `$VAR` and `${VAR}`. Null when a variable is unset or unknown, or an expansion is left. */
  const expand = (word: string): string | null => {
    const names = [...word.matchAll(/\$\{(\w+)\}|\$(\w+)/g)].map((m) => (m[1] ?? m[2]) as string);
    if (/^~(?=\/|$)/.test(word)) {
      if (state.env.HOME === undefined) return null;
      names.push("HOME");
    }
    if (names.length > 0 && (allUnknown || names.some((name) => state.unknownVars.has(name)))) {
      return null;
    }
    const expanded = expandPath(word, state.env);
    return expanded === null || /[$`]/.test(expanded) ? null : expanded;
  };
  /** The writes may not have run: make each variable or the directory unknown. */
  const forget = (writes: Write[]) => {
    for (const write of writes) {
      if ("dir" in write) state.dir = null;
      else state.unknownVars.add(write.name);
    }
    writes.length = 0;
  };
  /** Remember an applied write, to forget it where the parser cannot tell whether it ran. */
  const applied = (write: Write) => {
    const frame = top();
    if (frame.tail === "and") frame.list.push(write);
    if (isCompound(frame)) frame.block.push(write);
  };

  /** Process one segment. `dry` reads it for its writes only, all of them unknown. */
  const step = (segment: ShellSegment, dry: boolean) => {
    const { words, stdin, depth, ops } = segment;
    while (scopes.length < depth) scopes.push(copy(state));
    while (scopes.length > Math.max(depth, 0)) {
      // Leaving a subshell restores its state; unknown variables stay unknown.
      const outer = scopes.pop() as ShellState;
      outer.unknownVars = new Set([...outer.unknownVars, ...state.unknownVars]);
      state = outer;
    }
    if (depth < 0) {
      // An unmatched `)` (a `case` pattern): the subshell model no longer holds.
      allUnknown = true;
      state.dir = null;
    }

    let continued = false;
    for (const op of ops) {
      const frame = top();
      if (op === "&&" || op === "||") {
        if (op === "||") forget(frame.list);
        frame.tail = op === "&&" ? "and" : "or";
        continued = true;
      } else if (op === "|") {
        continued = true;
      } else if (op === "(") {
        frames.push(newFrame("paren"));
        continued = false;
      } else if (op === ")") {
        // A subshell's writes stay in it. In `case`, `)` starts another arm.
        if (frame.kind === "paren") frames.pop();
        else if (frame.kind === "case") {
          forget(frame.block);
          forget(frame.list);
          frame.tail = "none";
        }
        continued = false;
      } else if (!(op === "\n" && continued)) {
        // `;`, `&` or a newline ends the and-or list.
        forget(frame.list);
        frame.tail = "none";
        continued = false;
      }
    }
    const reserved = scanReservedWords(words);
    if (reserved.functionKeyword || ops.some((op, k) => op === "(" && ops[k + 1] === ")")) {
      allUnknown = true;
      dirUnknown = true;
    }
    for (const action of reserved.actions) {
      const frame = top();
      if (action === "branch" || action === "close") {
        forget(frame.block);
        forget(frame.list);
        frame.tail = "none";
        if (action === "close" && isCompound(frame)) frames.pop();
      } else frames.push(newFrame(action));
    }
    // A write here may not run, or may not persist: it makes its target unknown.
    const uncertain = dry || segment.async || top().tail === "or";

    /** Set a shell variable; `value` null means the parser cannot know it. */
    const assign = (name: string, value: string | null) => {
      if (uncertain || value === null || /[$`]|^~|:~/.test(value)) {
        state.unknownVars.add(name);
        return;
      }
      state.env[name] = value;
      state.unknownVars.delete(name);
      applied({ name });
    };

    for (const word of words) {
      for (const match of word.matchAll(/\$\{(\w+):?=/g)) state.unknownVars.add(match[1] as string);
    }

    const start = reserved.start;
    let i = start;
    while (i < words.length && ASSIGNMENT.test(words[i] as string)) i++;
    const assignments = words.slice(start, i).map((w) => ASSIGNMENT.exec(w) as RegExpExecArray);
    const rest = words.slice(i);
    const cmd = rest[0];
    if (cmd === undefined) {
      // Only assignments: they set shell variables (exported only if already exported).
      for (const [, name, index, append, value] of assignments) {
        assign(name as string, index || append ? null : (value as string));
      }
      return;
    }
    if (SPECIAL_BUILTINS.has(cmd)) {
      for (const [, name] of assignments) state.unknownVars.add(name as string);
    }

    if (cmd === "cd" || cmd === "pushd") {
      const operands = rest.slice(1);
      while (operands[0] !== undefined && /^-[LPe@]+$/.test(operands[0])) operands.shift();
      if (operands[0] === "--") operands.shift();
      if (operands.length > 1) return; // bash: too many arguments, cd fails
      const operand = operands[0] ?? "~";
      const target = operand === "-" ? null : expand(operand);
      const dir = state.dir;
      if (uncertain || target === null) state.dir = null;
      else {
        state.dir = isAbsolute(target) ? target : dir === null ? null : resolve(dir, target);
        applied({ dir: true });
      }
      return;
    }
    if (cmd === "popd") {
      state.dir = null;
      return;
    }
    if (cmd === "export") {
      for (const word of rest.slice(1)) {
        if (word.startsWith("-")) {
          allUnknown = true; // `export -n`, `-f`, `-p`
          continue;
        }
        const match = ASSIGNMENT.exec(word);
        const name = match?.[1] ?? word;
        if (match) assign(name, match[2] || match[3] ? null : (match[4] as string));
        if (uncertain) state.unknownVars.add(name);
        else {
          state.exported.add(name);
          applied({ name });
        }
      }
      return;
    }
    if (cmd === "unset") {
      const operands = rest.slice(1);
      if (operands.some((w) => /^-\w*f/.test(w))) return; // functions, not variables
      for (const name of operands.filter((w) => !w.startsWith("-"))) {
        if (uncertain) {
          state.unknownVars.add(name);
          continue;
        }
        state.env[name] = undefined;
        state.exported.delete(name);
        state.unknownVars.delete(name);
        applied({ name });
      }
      return;
    }
    if (cmd === "for" || cmd === "select") {
      const name = rest[1] ?? "";
      if (/^[A-Za-z_]\w*$/.test(name)) state.unknownVars.add(name);
      else allUnknown = true;
      return;
    }
    if (
      UNMODELED_VARIABLE_COMMANDS.has(cmd) ||
      (cmd === "printf" && rest.some((w) => /^-v/.test(w)))
    ) {
      // `eval` runs its words as a command in this shell.
      if (cmd === "eval" && !dry) {
        found.push(
          ...parseWithState(rest.slice(1).join(" "), copy(state), { allUnknown, dirUnknown }),
        );
      }
      allUnknown = true;
      if (cmd === "source" || cmd === "." || cmd === "eval") state.dir = null; // may `cd`
      return;
    }

    // `gh` (or a nested shell) must be the command word: only env assignments
    // or wrappers may precede it. A wrapper may take flags (`env -u GH_REPO`,
    // `env -C dir`): then the cwd and `GH_REPO` that gh sees are unknown.
    const offset = rest.findIndex((w) => !ASSIGNMENT.test(w) && !COMMAND_WRAPPERS.has(w));
    let gh = offset === -1 ? -1 : i + offset;
    if (COMMAND_WRAPPERS.has(cmd) && !isGhWord(words[gh]) && !isShellWord(words[gh])) {
      gh = words.findIndex((w, k) => k > i && (isGhWord(w) || isShellWord(w)));
    }
    const wrapperFlags = gh > i && words.slice(i, gh).some((w) => w.startsWith("-"));
    if (isShellWord(words[gh])) {
      // `bash -c SCRIPT`: parse SCRIPT in a child shell that sees exported variables.
      const flag = words.findIndex((w, k) => k > gh && /^-\w*c\w*$/.test(w));
      const script = flag === -1 ? undefined : words[flag + 1];
      if (script !== undefined && !dry) {
        const child = copy(state);
        for (const name of Object.keys(child.env)) {
          if (!child.exported.has(name)) child.env[name] = undefined;
        }
        for (const w of words.slice(start, gh)) {
          const match = ASSIGNMENT.exec(w);
          if (!match) continue;
          const name = match[1] as string;
          child.exported.add(name);
          if (match[2] || match[3] || /[$`]|^~|:~/.test(match[4] as string))
            child.unknownVars.add(name);
          else child.env[name] = match[4];
        }
        if (wrapperFlags) child.dir = null;
        found.push(
          ...parseWithState(script, child, {
            allUnknown: allUnknown || wrapperFlags,
            dirUnknown,
          }),
        );
      }
      return;
    }
    if (!isGhWord(words[gh])) {
      // A backtick splits `X=`a b`` into words the parser cannot assign.
      if (words.some((w) => w.includes("`"))) allUnknown = true;
      return;
    }
    if (dry) return;
    const args = parseGhArgs(words.slice(gh + 1));
    const [group, action, target] = args.positionals;
    if (group !== "pr" || (action !== "create" && action !== "edit")) return;

    const values = (...names: string[]) =>
      args.flags.filter(([name]) => names.includes(name)).map(([, value]) => value);
    const prefixRepo = words
      .slice(start, gh)
      .find((w) => w.startsWith("GH_REPO="))
      ?.slice("GH_REPO=".length);
    const editTarget: EditTarget =
      action === "edit" ? classifyEditTarget(target, expand) : { kind: "local" };
    let repos = [...values("repo"), ...(editTarget.kind === "url" ? [editTarget.repo] : [])];
    let unknownTarget = editTarget.kind === "unknown";
    let alsoCheckout = false;
    if (repos.length === 0) {
      if (prefixRepo) repos = [prefixRepo];
      else if (allUnknown || wrapperFlags || state.unknownVars.has("GH_REPO")) unknownTarget = true;
      else if (state.env.GH_REPO) {
        repos = [state.env.GH_REPO];
        // A plain `GH_REPO=x` reaches gh only when exported (`set -a`): check the checkout too.
        alsoCheckout = !state.exported.has("GH_REPO");
      }
    }

    const inline = values("title", "body");
    const files = values("body-file").filter((file) => file !== "-");
    const fromStdin = values("body-file").includes("-");
    if (fromStdin && args.stdinFile !== undefined) files.push(args.stdinFile);
    const bodyFiles: string[] = [];
    const unresolvedBodyFiles: string[] = [];
    for (const file of files) {
      const expanded = expand(file);
      if (expanded === null) unresolvedBodyFiles.push(file);
      else bodyFiles.push(expanded);
    }
    found.push({
      cwd: wrapperFlags || dirUnknown ? null : state.dir,
      repos: [...new Set(repos)],
      alsoCheckout,
      unknownTarget,
      texts: [...inline, ...(fromStdin ? stdin : [])],
      bodyFiles,
      unresolvedBodyFiles,
      // An unquoted `$(` splits at the paren, leaving a value that ends in `$`.
      // In the edit target, it also cuts every later flag off this segment.
      opaqueBody:
        inline.some((value) => value.endsWith("$")) ||
        (action === "edit" && target?.endsWith("$") === true) ||
        (fromStdin && stdin.length === 0 && args.stdinFile === undefined),
    });
  };

  const segments = tokenizeShell(command);
  const ends = loopEnds(segments);
  segments.forEach((segment, index) => {
    const end = ends[index];
    if (end !== undefined) {
      // A loop body can run again after any of its writes: read it once for
      // its writes, so they are unknown from the top of the body.
      const saved = frames.map(copyFrame);
      for (let k = index; k <= end; k++) step(segments[k] as ShellSegment, true);
      frames = saved;
    }
    step(segment, false);
  });
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
    let unreadable: string | undefined = call.unresolvedBodyFiles[0];
    for (const bodyFile of call.bodyFiles) {
      try {
        const base = isAbsolute(bodyFile) ? "/" : call.cwd;
        if (base === null) throw new Error("unknown working directory");
        for (const leak of findPrBodyLeaks(await deps.readFile(resolve(base, bodyFile)))) {
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
        ? [...call.repos, ...(call.alsoCheckout ? [undefined] : [])]
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
