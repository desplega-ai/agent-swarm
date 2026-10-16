#!/usr/bin/env bash
# run-qa.sh: record a UI QA pass with agent-browser and write steps.json.
# Every step offset is in seconds from the moment recording starts.
#
# Usage: BASE_URL=http://localhost:5274 OUT=./loom bash run-qa.sh
# Needs: agent-browser (with `record`), jq, GNU date (%N). No bc: time math runs in jq.
#
# Replace the two example steps with the steps that prove your change.
set -euo pipefail
BASE_URL=${BASE_URL:-http://localhost:5274}
OUT=${OUT:-./loom}
mkdir -p "$OUT"
LOG="$OUT/steps.ndjson"
: >"$LOG"

now() { date +%s.%N; }
# act: call right before the action fires. It marks the step start.
act() { STEP_START=$(now); }
# step <action> <observed> <verdict> <narration>: call AFTER the resulting screen has
# rendered (after an `agent-browser wait <selector>`). That moment becomes visualAt.
step() {
  jq -nc --arg a "$1" --arg o "$2" --arg v "$3" --arg n "$4" \
    --arg t0 "$T0" --arg s "$STEP_START" --arg va "$(now)" \
    '{action:$a, observed:$o, verdict:$v, narration:$n,
      start:(($s|tonumber)-($t0|tonumber)), visualAt:(($va|tonumber)-($t0|tonumber))}' >>"$LOG"
}

# Log in and seed data BEFORE recording starts.
agent-browser set viewport 1920 1080 >/dev/null
agent-browser open "$BASE_URL" >/dev/null
agent-browser wait 1500 >/dev/null
agent-browser record start "$OUT/raw.webm" --cursor --fps 30 >/dev/null
T0=$(now)

act
agent-browser reload >/dev/null
agent-browser wait h1 >/dev/null
step "Load home page" "Heading and nav render" pass "The home page loads with its heading and nav."
agent-browser wait 800 >/dev/null # dwell so the viewer sees the result before the next action

act
agent-browser open "$BASE_URL/settings" >/dev/null
agent-browser wait h1 >/dev/null
step "Open settings" "Settings page renders" pass "The settings page opens."
agent-browser wait 800 >/dev/null

END=$(jq -n --arg a "$(now)" --arg b "$T0" '($a|tonumber)-($b|tonumber)')
agent-browser record stop >/dev/null

# Each step ends where the next one starts; the last one ends at record stop.
jq -s --argjson end "$END" '
  {steps: ([to_entries[] | .value + {idx: (.key + 1)}]
    | . as $s
    | [range(0; length) as $i
        | $s[$i] + {end: (if $i + 1 < ($s | length) then $s[$i + 1].start else $end end)}])}
' "$LOG" >"$OUT/steps.json"
jq -c '.steps[] | {idx, start, visualAt, end, verdict}' "$OUT/steps.json"
