#!/usr/bin/env bash
# Long runs: larger constants (exhaustive, time-capped) + random simulation.
set -u
cap=${CAP:-900}
mk(){ # base cfg, overrides...
  cfg=$(mktemp /tmp/long-XXXX.cfg); base=$1; shift; cp "$base" "$cfg"
  for kv in "$@"; do k=${kv%%=*}; v=${kv#*=}; sed -i "s/^\(\s*$k = \).*/\1$v/" "$cfg"; done
  # safety-only for the big exhaustive runs (liveness needs the full graph in memory)
  sed -i '/^PROPERTIES/,$d; /SupersededHasResume/d' "$cfg"; echo "$cfg"; }
run(){ label=$1; spec=$2; cfg=$3; shift 3
  start=$(date +%s); out=$(timeout $cap ./tlc.sh "$spec" "$cfg" "$@" 2>&1); rc=$?
  end=$(date +%s)
  echo "### $label (exit $rc, wall $((end-start))s)"
  echo "$out" | grep -E "violated|No error has been found|distinct states found|depth of the complete|traces|Progress\(" | tail -4
}
BIG="Workers={w1,w2,w3} MaxVer=2 MaxWorkerCrashes=2 MaxApiCrashes=2"
FIX="FIX_NO_REBOOT=TRUE"
run "Heartbeat (fixed) exhaustive, 3 workers, 4 slots, MaxGen 3" Heartbeat "$(mk Heartbeat.cfg $BIG NTasks=4 MaxGen=3 $FIX)"
run "HeartbeatSimple exhaustive, 3 workers, 2 tasks, MaxGen 3" HeartbeatSimple "$(mk HeartbeatSimple.cfg $BIG NTasks=2 MaxGen=3)"
run "Heartbeat (current code) simulate" Heartbeat "$(mk Heartbeat.cfg $BIG NTasks=4 MaxGen=3)" -simulate -depth 100
run "Heartbeat (fixed) simulate" Heartbeat "$(mk Heartbeat.cfg $BIG NTasks=4 MaxGen=3 $FIX)" -simulate -depth 100
run "HeartbeatSimple simulate" HeartbeatSimple "$(mk HeartbeatSimple.cfg $BIG NTasks=2 MaxGen=3)" -simulate -depth 100
