#!/usr/bin/env bash
# Usage: ./run-props.sh <Spec> <base.cfg> [KEY=VAL ...]
# Checks each invariant/property from base.cfg in its own TLC run (TLC stops at
# the first violation), with constant overrides. Prints one line per property.
spec=$1; base=$2; shift 2
props=$(awk '/^(INVARIANTS|PROPERTIES)/{k=$1;next} /^[A-Z_]+$/{k=""} k && NF{print k" "$1}' "$base")
while read -r kind name; do
  cfg=$(mktemp /tmp/hb-XXXX.cfg)
  awk '/^(INVARIANTS|PROPERTIES)/{exit} {print}' "$base" > "$cfg"
  for kv in "$@"; do k=${kv%%=*}; v=${kv#*=}; sed -i "s/^\(\s*$k = \).*/\1$v/" "$cfg"; done
  echo "$kind $name" >> "$cfg"
  out=$(./tlc.sh "$spec" "$cfg" 2>&1)
  res=$(echo "$out" | grep -m1 -E "No error has been found|is violated|Temporal properties were violated|Error:" )
  st=$(echo "$out" | grep "distinct states found" | tail -1 | sed -E "s/.* ([0-9,]+) distinct states found.*/\1/")
  echo "$name | ${res:-?} | distinct=$st"
  rm -f "$cfg"
done <<< "$props"
