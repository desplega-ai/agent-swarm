#!/usr/bin/env bash
# Check launcher arguments without starting a JVM. Optional launcher path tests an older version.
set -euo pipefail
launcher=${1:-$(dirname "$0")/tlc.sh}
home=$(mktemp -d)
trap 'rm -rf "$home"' EXIT
mkdir -p "$home/jre/bin"
cat > "$home/jre/bin/java" <<'JAVA'
#!/usr/bin/env bash
printf '%s\n' "$@"
JAVA
chmod +x "$home/jre/bin/java"

check() {
  local workers=$1 heap=$2 direct=$3
  shift 3
  local -a args
  mapfile -t args < <(env -u TLC_WORKERS -u TLC_HEAP -u TLC_DIRECT_MEMORY TLC_HOME="$home" "$@" bash "$launcher" Spec model.cfg -fp 0)
  [[ ${args[0]} == -XX:+UseParallelGC ]]
  [[ ${args[1]} == "-Xmx$heap" && ${args[2]} == "-XX:MaxDirectMemorySize=$direct" ]]
  [[ ${args[3]} == -cp && ${args[4]} == "$home/tla2tools.jar" && ${args[5]} == tlc2.TLC ]]
  [[ ${args[6]} == -config && ${args[7]} == model.cfg && ${args[8]} == -workers && ${args[9]} == "$workers" ]]
  [[ ${args[10]} == -deadlock && ${args[11]} == -nowarning && ${args[12]} == -metadir && ${args[13]} == /tmp/tlc-meta/* ]]
  [[ ${args[14]} == -fp && ${args[15]} == 0 && ${args[16]} == Spec && ${#args[@]} == 17 ]]
}
check 4 6g 4g env
check 4 6g 4g env TLC_WORKERS=auto
check 2 6g 4g env TLC_WORKERS=2
check 4 6g 4g env TLC_WORKERS= TLC_HEAP= TLC_DIRECT_MEMORY=
check 4 1g 512m env TLC_HEAP=1g TLC_DIRECT_MEMORY=512m
echo 'TLC launcher checks passed'
