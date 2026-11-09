#!/usr/bin/env bash
# Check run-props.sh grouping and cache without starting a JVM: a stub tlc.sh reads the generated
# cfg and reports the first listed name in $BAD as violated. Optional runner path tests another version.
set -euo pipefail
runner=$(realpath "${1:-$(dirname "$0")/run-props.sh}")
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cd "$dir"
mkdir home && : > home/tla2tools.jar
export TLC_HOME=$dir/home
cat > tlc.sh <<'TLC'
#!/usr/bin/env bash
cfg=$2
names=$(awk '/^(INVARIANTS|PROPERTIES)/{on=1;next} on && NF{print $1}' "$cfg" | paste -sd, -)
echo "$names" >> runs.log
if [[ -n ${BAD_SPEC:-} && $1 == "$BAD_SPEC" ]]; then
  echo "Error: Invariant ${names%%,*} is violated."
  echo "12 states generated, 7 distinct states found, 0 states left on queue."
  exit 12
fi
for n in ${names//,/ }; do
  for b in ${BAD:-}; do
    if [[ $n == "$b" ]]; then
      if grep -q '^PROPERTIES' "$cfg"; then echo "Error: Temporal properties were violated."; else echo "Error: Invariant $n is violated."; fi
      echo "12 states generated, 7 distinct states found, 0 states left on queue."
      exit 12
    fi
  done
done
echo "Model checking completed. No error has been found."
echo "900 states generated, 100 distinct states found, 0 states left on queue."
TLC
chmod +x tlc.sh
echo '---- MODULE M ----' > M.tla
cat > M.cfg <<'CFG'
SPECIFICATION Spec
CONSTANTS
    N = 2
INVARIANTS
    A
    B
    C
PROPERTIES
    P
    Q
CFG

fail() { echo "FAIL: $*"; cat runs.log; exit 1; }
expect() { [[ $(cat runs.log | paste -sd';' -) == "$1" ]] || fail "runs: want $1"; }

# Shared runs: invariant B is named and dropped, the rest pass together; one run for P and Q.
out=$(BAD=B bash "$runner" M M.cfg)
expect "A,B,C;A,C;P,Q"
grep -qx "B | Error: Invariant B is violated. | distinct=7" <<< "$out" || fail "B line: $out"
grep -qx "A | Model checking completed. No error has been found. | distinct=100" <<< "$out" || fail "A line: $out"
[[ $(wc -l <<< "$out") == 5 ]] || fail "line count: $out"

# An unnamed temporal violation re-checks each property alone.
rm runs.log
BAD=Q bash "$runner" M M.cfg > /dev/null
expect "A,B,C;P,Q;P;Q"

# TLC_SPLIT=1 keeps one run per name.
rm runs.log
TLC_SPLIT=1 bash "$runner" M M.cfg > /dev/null
expect "A;B;C;P;Q"

# Cache: a second run with the same inputs starts no TLC and marks every line cached.
rm runs.log
export TLC_CACHE_DIR=$dir/cache
BAD=B bash "$runner" M M.cfg > /dev/null
rm runs.log
out=$(BAD=B bash "$runner" M M.cfg)
[[ ! -e runs.log ]] || fail "cache hit still ran TLC"
[[ $(grep -c '| cached$' <<< "$out") == 5 ]] || fail "cached lines: $out"

# A partial cache (restart mid-run) re-runs only what is missing.
rm "$TLC_CACHE_DIR"/*
BAD=B bash "$runner" M M.cfg > /dev/null
rm runs.log
grep -l '^P |' "$TLC_CACHE_DIR"/* | xargs rm
BAD=B bash "$runner" M M.cfg > /dev/null
expect "P"

# A changed module, cfg override or launcher misses the cache.
for change in "echo '\\* edit' >> M.tla" "true" "echo '# edit' >> tlc.sh"; do
  eval "$change"
  rm -f runs.log
  if [[ $change == true ]]; then BAD=B bash "$runner" M M.cfg N=3 > /dev/null; else BAD=B bash "$runner" M M.cfg > /dev/null; fi
  expect "A,B,C;A,C;P,Q"
done

# Two root modules in one directory with the same cfg keep separate verdicts.
rm -rf "$TLC_CACHE_DIR" runs.log
echo '---- MODULE N ----' > N.tla
bash "$runner" M M.cfg > /dev/null
rm runs.log
out=$(BAD_SPEC=N bash "$runner" N M.cfg)
[[ -s runs.log ]] || fail "spec N reused spec M's cached verdicts"
grep -qx "A | Error: Invariant A is violated. | distinct=7" <<< "$out" || fail "spec N line: $out"

# A TLC error is never cached.
rm -rf "$TLC_CACHE_DIR" runs.log
printf '#!/usr/bin/env bash\necho "Error: TLC threw an unexpected exception."\n' > tlc.sh
bash "$runner" M M.cfg > /dev/null
[[ -z $(ls -A "$TLC_CACHE_DIR") ]] || fail "TLC error was cached"
echo 'run-props checks passed'
