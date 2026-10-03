/**
 * PreToolUse guard: block `gh pr create` / `gh pr edit` when the PR body for
 * a PUBLIC repo carries internal identifiers (see `src/utils/pr-body-leaks.ts`).
 *
 * Shared by the Claude hook (`hook.ts`) and the codex hook (`codex-hook.ts`).
 * The block reason names leak categories only, never the matched text.
 *
 * Failure modes:
 *   - Body scanned clean: allow without a visibility lookup.
 *   - Body has leaks, or `--body-file` is unreadable: look up the repo
 *     visibility. PUBLIC blocks; PRIVATE / INTERNAL allows.
 *   - Visibility lookup fails: block (fail closed). We already know the body
 *     is unsafe or unreadable, and we cannot prove the repo is private.
 *   - Body comes from an unexpanded shell variable (`--body "$BODY"`): the
 *     guard cannot see it and allows (fail open). CI still checks the body.
 */

import { isAbsolute, resolve } from "node:path";
import { findPrBodyLeaks, type LeakCategory } from "../utils/pr-body-leaks";

export type GhPrInvocation = {
  /** Working directory of the `gh` call, after any `cd` earlier in the command. */
  cwd: string;
  /** `--repo` / `-R` value, when given. */
  repo?: string;
  /** Body text is inline (`--body`, `-b`, or `--body-file -` with a heredoc). */
  inlineBody: boolean;
  /** `--body-file` / `-F` path as written, when it is not `-`. */
  bodyFile?: string;
};

export type PrBodyGuardDeps = {
  readFile: (path: string) => Promise<string>;
  /** Returns GitHub's `visibility` (PUBLIC, PRIVATE, INTERNAL). Throws when the lookup fails. */
  repoVisibility: (target: { cwd: string; repo?: string }) => Promise<string>;
  env: Record<string, string | undefined>;
};

const SEPARATORS = ["&&", "||", ";", "|", "&", "\n", "(", ")"];
const COMMAND_WRAPPERS = new Set(["env", "command", "exec", "time", "sudo", "nohup"]);

/** Split a shell command into segments of words. Handles quotes and backslashes, not expansions. */
export function tokenizeShell(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (inWord) segments[segments.length - 1]?.push(word);
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
    const sep = SEPARATORS.find((s) => command.startsWith(s, i));
    if (sep) {
      push();
      segments.push([]);
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
  return segments.filter((s) => s.length > 0);
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

/** Value of `--name value`, `--name=value` or `-x value` within `args`. */
function flagValue(args: string[], long: string, short: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === long || arg === short) return args[i + 1];
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
  }
  return undefined;
}

/** Find every `gh pr create|edit` call in a shell command. */
export function parseGhPrCommands(
  command: string,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): GhPrInvocation[] {
  const found: GhPrInvocation[] = [];
  let dir = cwd;
  for (const words of tokenizeShell(command)) {
    if ((words[0] === "cd" || words[0] === "pushd") && words.length <= 2) {
      const target = expandPath(words[1] ?? env.HOME ?? dir, env);
      if (target !== null) dir = isAbsolute(target) ? target : resolve(dir, target);
      continue;
    }
    // `gh` must be the command word: only env assignments or wrappers may precede it.
    const gh = words.findIndex((w) => !/^\w+=/.test(w) && !COMMAND_WRAPPERS.has(w));
    const word = words[gh] ?? "";
    if (
      !(word === "gh" || word.endsWith("/gh")) ||
      words[gh + 1] !== "pr" ||
      (words[gh + 2] !== "create" && words[gh + 2] !== "edit")
    ) {
      continue;
    }
    const args = words.slice(gh + 3);
    const bodyFile = flagValue(args, "--body-file", "-F");
    found.push({
      cwd: dir,
      repo: flagValue(args, "--repo", "-R"),
      inlineBody: flagValue(args, "--body", "-b") !== undefined || bodyFile === "-",
      bodyFile: bodyFile === "-" ? undefined : bodyFile,
    });
  }
  return found;
}

const BLOCK_ADVICE =
  "Paraphrase the motivation ('a maintainer asked for X') and link only public sources (Fixes #N, a public PR or issue). Internal provenance stays in the swarm task.";

/**
 * Check a shell command. Returns a block reason, or null to allow.
 * An inline body is scanned as the whole command text: a heredoc inside
 * `--body "$(cat <<'EOF' ...)"` does not tokenize cleanly, and the title is public too.
 */
export async function checkGhPrCommand(
  command: string,
  cwd: string,
  deps: PrBodyGuardDeps,
): Promise<string | null> {
  if (!/\bgh\b[\s\S]*\bpr\b/.test(command)) return null;
  for (const call of parseGhPrCommands(command, cwd, deps.env)) {
    const leaks = new Set<LeakCategory>(call.inlineBody ? findPrBodyLeaks(command) : []);
    let unreadable: string | undefined;
    if (call.bodyFile !== undefined) {
      const expanded = expandPath(call.bodyFile, deps.env);
      try {
        if (expanded === null) throw new Error("unset variable");
        const path = isAbsolute(expanded) ? expanded : resolve(call.cwd, expanded);
        for (const leak of findPrBodyLeaks(await deps.readFile(path))) leaks.add(leak);
      } catch {
        unreadable = call.bodyFile;
      }
    }
    if (leaks.size === 0 && unreadable === undefined) continue;

    let visibility: string;
    try {
      visibility = (await deps.repoVisibility({ cwd: call.cwd, repo: call.repo })).trim();
    } catch {
      visibility = "UNKNOWN";
    }
    if (visibility === "PRIVATE" || visibility === "INTERNAL") continue;

    const target =
      visibility === "PUBLIC"
        ? "this public repo"
        : "a repo whose visibility could not be confirmed";
    if (leaks.size > 0) {
      return `PR body leak check: the PR body for ${target} contains internal identifiers (${[...leaks].join(", ")}). ${BLOCK_ADVICE}`;
    }
    return `PR body leak check: could not read --body-file ${unreadable} for ${target}, so the body was not checked. Pass a literal path to a file that exists.`;
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
