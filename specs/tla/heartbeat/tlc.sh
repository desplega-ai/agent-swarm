#!/usr/bin/env bash
# Usage: ./tlc.sh <Spec> <cfg> [extra TLC args]. TLC_HOME defaults to /workspace/personal/fv.
TLC_HOME=${TLC_HOME:-/workspace/personal/fv}
spec=$1; cfg=$2; shift 2
workers=${TLC_WORKERS:-4}
if [[ "$workers" == auto ]]; then workers=4; fi
exec "$TLC_HOME/jre/bin/java" -XX:+UseParallelGC -Xmx"${TLC_HEAP:-6g}" -XX:MaxDirectMemorySize="${TLC_DIRECT_MEMORY:-4g}" -cp "$TLC_HOME/tla2tools.jar" tlc2.TLC \
  -config "$cfg" -workers "$workers" -deadlock -nowarning -metadir "/tmp/tlc-meta/$$" "$@" "$spec"
