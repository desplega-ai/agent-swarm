#!/usr/bin/env bash
# Usage: ./tlc.sh <Spec> <cfg> [extra TLC args]. TLC_HOME defaults to /workspace/personal/fv.
TLC_HOME=${TLC_HOME:-/workspace/personal/fv}
spec=$1; cfg=$2; shift 2
exec "$TLC_HOME/jre/bin/java" -XX:+UseParallelGC -cp "$TLC_HOME/tla2tools.jar" tlc2.TLC \
  -config "$cfg" -workers auto -deadlock -nowarning -metadir "/tmp/tlc-meta/$$" "$@" "$spec"
