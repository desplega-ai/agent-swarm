#!/usr/bin/env bash
# Usage: ./trace.sh <Spec> <base.cfg> <PropKind> <PropName> [KEY=VAL ...]  -> action names of the counterexample
spec=$1; base=$2; kind=$3; name=$4; shift 4
cfg=$(mktemp /tmp/hbt-XXXX.cfg)
awk '/^(INVARIANTS|PROPERTIES)/{exit} {print}' "$base" > "$cfg"
for kv in "$@"; do k=${kv%%=*}; v=${kv#*=}; sed -i "s/^\(\s*$k = \).*/\1$v/" "$cfg"; done
echo "$kind $name" >> "$cfg"
./tlc.sh "$spec" "$cfg" 2>&1 | grep -E "^State [0-9]+:|violated|No error|Back to state|Stuttering|distinct states found, 0" | sed -E 's/ line [0-9]+, col.*>/>/'
rm -f "$cfg"
