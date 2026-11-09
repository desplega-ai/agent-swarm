#!/usr/bin/env bash
# Usage: ./run-props.sh <Spec> <base.cfg> [KEY=VAL ...]
# Checks every invariant and property in base.cfg, with constant overrides. Prints one line per
# property as it resolves: "<name> | <TLC verdict> | distinct=<N>".
#
# Invariants share one TLC run, and so do properties. TLC stops at the first violation, so a
# violation it names is reported and the run repeats with the rest. A violation it does not name
# ("Temporal properties were violated") or a TLC error re-checks that group one property per run.
# A shared run checks the same properties on the same state graph, just once instead of per name.
# TLC_SPLIT=1 runs one TLC per property, as before.
#
# TLC_CACHE_DIR (optional): keep each verdict in that directory, keyed by a hash of the *.tla
# modules, the root module name, the generated cfg, tlc.sh and tla2tools.jar. A later run with the
# same inputs prints the stored line with "| cached" instead of running TLC, so a restart mid-run
# loses at most the TLC run in flight. Only "No error has been found" and violations are stored, never a TLC error.
set -uo pipefail
spec=$1; base=$2; shift 2
work=$(mktemp -d /tmp/hb-XXXX)
trap 'rm -rf "$work"' EXIT
awk '/^(INVARIANTS|PROPERTIES)/{exit} {print}' "$base" > "$work/head.cfg"
for kv in "$@"; do k=${kv%%=*}; v=${kv#*=}; sed -i "s/^\(\s*$k = \).*/\1$v/" "$work/head.cfg"; done
props=$(awk '/^(INVARIANTS|PROPERTIES)/{k=$1;next} /^[A-Z_]+$/{k=""} k && NF{print k" "$1}' "$base")

digest() { sha256sum | cut -d' ' -f1; }
cache=${TLC_CACHE_DIR:-}
inputs=""
if [[ -n $cache ]]; then
  mkdir -p "$cache"
  inputs=$({
    echo "tlc.sh $(digest < tlc.sh)"
    echo "jar $(digest < "${TLC_HOME:-/workspace/personal/fv}/tla2tools.jar" 2>/dev/null)"
    for f in *.tla; do [[ $f == *_TTrace_* ]] || echo "$f $(digest < "$f")"; done
    echo "spec $spec"
    echo "cfg $(digest < "$work/head.cfg")"
  } | digest)
fi
key() { echo "$inputs $1 $2" | digest; }

# run <kind> <name...>: one TLC run over these names; sets res (verdict line) and st (distinct).
run() {
  local kind=$1; shift
  { cat "$work/head.cfg"; echo "$kind"; printf '    %s\n' "$@"; } > "$work/run.cfg"
  local out
  out=$(./tlc.sh "$spec" "$work/run.cfg" 2>&1)
  res=$(echo "$out" | grep -m1 -E "No error has been found|is violated|Temporal properties were violated|Error:")
  st=$(echo "$out" | grep "distinct states found" | tail -1 | sed -E "s/.* ([0-9,]+) distinct states found.*/\1/")
}

# emit <kind> <name>: print the line for the last run, and store a definitive verdict.
emit() {
  local line="$2 | ${res:-?} | distinct=$st"
  echo "$line"
  if [[ -n $cache && $res =~ (No\ error\ has\ been\ found|is\ violated|Temporal\ properties\ were\ violated) ]]; then
    echo "$line" > "$cache/$(key "$1" "$2").tmp" && mv "$cache/$(key "$1" "$2").tmp" "$cache/$(key "$1" "$2")"
  fi
}

check_group() {
  local kind=$1; shift
  local -a todo=()
  local n
  for n in "$@"; do
    if [[ -n $cache && -s $cache/$(key "$kind" "$n") ]]; then
      echo "$(cat "$cache/$(key "$kind" "$n")") | cached"
    else
      todo+=("$n")
    fi
  done
  while ((${#todo[@]})); do
    if [[ ${TLC_SPLIT:-} == 1 ]] || ((${#todo[@]} == 1)); then
      for n in "${todo[@]}"; do run "$kind" "$n"; emit "$kind" "$n"; done
      return
    fi
    run "$kind" "${todo[@]}"
    if [[ $res == *"No error has been found"* ]]; then
      for n in "${todo[@]}"; do emit "$kind" "$n"; done
      return
    fi
    local hit=""
    [[ $res =~ (Invariant|Action\ property|Property)\ ([A-Za-z0-9_]+)\ is\ violated ]] && hit=${BASH_REMATCH[2]}
    if [[ -z $hit || " ${todo[*]} " != *" $hit "* ]]; then
      for n in "${todo[@]}"; do run "$kind" "$n"; emit "$kind" "$n"; done
      return
    fi
    emit "$kind" "$hit"
    local -a rest=()
    for n in "${todo[@]}"; do [[ $n == "$hit" ]] || rest+=("$n"); done
    todo=("${rest[@]}")
  done
}

for kind in INVARIANTS PROPERTIES; do
  mapfile -t names < <(awk -v k="$kind" '$1==k{print $2}' <<< "$props")
  ((${#names[@]})) && check_group "$kind" "${names[@]}"
done
