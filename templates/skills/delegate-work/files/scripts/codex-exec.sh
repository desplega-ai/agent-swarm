#!/usr/bin/env bash
#
# codex-exec.sh — invoke `codex exec` (non-interactive) for delegated
# implementation work. This is the SINGLE SOURCE OF TRUTH for the invocation
# flags. The delegate-work skill calls only this script; its routing matrix
# decides WHICH gpt-5.6 variant (-m) and effort (-e) each task gets:
#   luna  = mechanical/bounded     terra = everyday frozen-spec slice
#   sol   = hard/long-horizon      effort: medium|high|xhigh|max (never ultra)
#
# Usage:
#   codex-exec.sh [-m <model>] [-e <effort>] -C <workdir> -o <last-message-file> [-l <log-file>] "PROMPT"
#   printf '%s' "$PROMPT" | codex-exec.sh -C <workdir> -o <file>     # prompt via stdin (preferred)
#
# Notes:
#   * -C sets codex's working root (the git worktree, for parallel isolation).
#   * -o writes codex's final message (its report) to a file you can read back.
#   * Reads the prompt from stdin when no positional PROMPT is given.
#   * In `exec` mode approvals are already "never", so nothing hangs waiting for
#     a human. The sandbox mode below bounds what codex may WRITE.
#
# Sandbox default: `workspace-write` — codex may freely edit files inside its
# working root (the worktree) and read elsewhere on disk (so it can read the
# plan by absolute path), but cannot write outside the workspace. This keeps
# parallel worktree runs from clobbering each other or the main tree.
#
# Env overrides (flags -m/-e take precedence):
#   CODEX_MODEL   default: gpt-5.6-sol          gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-luna
#   CODEX_EFFORT  default: high                 reasoning effort (never "fast"/low)
#   CODEX_SANDBOX default: workspace-write      read-only | workspace-write | danger-full-access
#   CODEX_BYPASS  set to 1 to use --dangerously-bypass-approvals-and-sandbox
#                 (fully unsandboxed — opt in only when a phase must write
#                 outside its worktree; overrides CODEX_SANDBOX)
set -euo pipefail

WORKDIR="."
OUTFILE=""
LOGFILE=""
PROMPT=""
MODEL_FLAG=""
EFFORT_FLAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)  MODEL_FLAG="$2"; shift 2 ;;
    -e|--effort) EFFORT_FLAG="$2"; shift 2 ;;
    -C|--cd)  WORKDIR="$2"; shift 2 ;;
    -o|--out) OUTFILE="$2"; shift 2 ;;
    -l|--log) LOGFILE="$2"; shift 2 ;;
    --)       shift; PROMPT="${1:-}"; break ;;
    -*)       echo "codex-exec.sh: unknown flag: $1" >&2; exit 2 ;;
    *)        PROMPT="$1"; shift ;;
  esac
done

MODEL="${MODEL_FLAG:-${CODEX_MODEL:-gpt-5.6-sol}}"
EFFORT="${EFFORT_FLAG:-${CODEX_EFFORT:-high}}"
SANDBOX="${CODEX_SANDBOX:-workspace-write}"

args=( exec
  -m "$MODEL"
  -c "model_reasoning_effort=\"$EFFORT\""
  -C "$WORKDIR"
)
if [[ "${CODEX_BYPASS:-0}" == "1" ]]; then
  args+=( --dangerously-bypass-approvals-and-sandbox )
else
  args+=( -s "$SANDBOX" )
fi
[[ -n "$OUTFILE" ]] && args+=( -o "$OUTFILE" )

# Prompt source: positional arg if present, otherwise stdin (`-`).
if [[ -n "$PROMPT" ]]; then
  set -- "$PROMPT"
else
  set -- "-"
fi

if [[ -n "$LOGFILE" ]]; then
  codex "${args[@]}" "$@" 2>&1 | tee "$LOGFILE"
else
  codex "${args[@]}" "$@"
fi
