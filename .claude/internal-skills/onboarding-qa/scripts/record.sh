#!/usr/bin/env bash
# Demo recording box: a QA box that sends no telemetry, with ttyd for the terminal take.
#
#   record.sh up <run> [image]     box.sh up (default image docker-ce), then block + prep (unzip, ttyd, its service off)
#   record.sh block <run>          make proxy.desplega.sh unreachable from the box and its containers (safe to re-run)
#   record.sh check <run>          prove the block: the rules exist, and every probe fails to connect (exit 1 otherwise)
#   record.sh term <run> [w h]     ttyd on the box loopback (light theme, Menlo 17, amber prompt) + an SSH forward,
#                                  then the tab in this shell's AGENT_BROWSER_SESSION at w x h (default 1280 760) @2x
#   record.sh term-stop <run>      stop ttyd and the forward
#   record.sh down <run>           term-stop, then box.sh down
#
# The block: the proxy's A and AAAA records are resolved here (dig) and on the box (getent, before /etc/hosts
# changes), /etc/hosts maps the name to 127.0.0.1 and ::1 for host processes, iptables (and ip6tables for any
# AAAA) REJECTs the IPs in OUTPUT, FORWARD and DOCKER-USER (containers resolve through Docker's DNS, not the
# host's /etc/hosts), and ~/.bashrc exports ANONYMIZED_TELEMETRY=false (the installer writes it into .env from
# the first release with #2499). `check` passes a probe only on a connect error (refused, unreachable, timed
# out): a TLS alert or an HTTP status means the box reached the proxy. The REJECT counters it prints show how
# many packets the block has stopped. The API still mints its telemetry_org_id locally at boot (box-api.sh GET
# '/api/config?scope=global&key=telemetry_org_id'): ClickHouse must have no rows for it (`telemetry.sh org <id>`),
# and `telemetry.sh new` must show no new install in the run window.
#
# The terminal take: ttyd listens on loopback only and the take reaches it through the forward
# (ONBOARDING_QA_TTYD_PORT, default 7681), so no port is exposed and no password is typed on camera. The shell
# runs under `script`, which appends everything on screen to ~/install.log on the box: `secrets.sh setup-url`
# reads the printed /setup link from that file, as in ui mode.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
PROXY_HOST="${ONBOARDING_QA_TELEMETRY_PROXY:-proxy.desplega.sh}"
TTYD_PORT="${ONBOARDING_QA_TTYD_PORT:-7681}"

usage() { sed -n '2,10p' "$0"; exit 2; }
bcn() { TZ=Europe/Madrid date '+%H:%M:%S'; }
on_box() { ssh -F "$dir/ssh_config" box "$@"; }
# ssh joins its arguments into one command line for the remote shell: quote each value that goes to `bash -s --`.
q() { printf '%q' "$1"; }
need_box() { [ -f "$dir/ssh_config" ] || { echo "no ssh config at $dir (record.sh up first)" >&2; exit 2; }; }
getkv() { grep "^$1=" "$dir/run.env" 2>/dev/null | cut -d= -f2- || true; }
setkv() {
  { grep -v "^$1=" "$dir/run.env" || true; printf '%s=%s\n' "$1" "$2"; } >"$dir/run.env.tmp" && mv "$dir/run.env.tmp" "$dir/run.env"
}
# The proxy's addresses as this Mac sees them, plus the ones a previous block stored. One per line.
# Both always exit 0 (an empty list is a valid answer under set -e -o pipefail).
resolve4() { { dig +short "$PROXY_HOST" A | grep -E '^[0-9]+(\.[0-9]+){3}$' || true; getkv PROXY_IPS | tr ' ' '\n'; } | grep . | sort -u || true; }
resolve6() { { dig +short "$PROXY_HOST" AAAA | grep -E '^[0-9a-fA-F:]+$' | grep : || true; getkv PROXY_IPS6 | tr ' ' '\n'; } | grep . | sort -u || true; }

cmd_block() {
  local ips4 ips6 out
  ips4="$(resolve4 | tr '\n' ' ')"
  ips6="$(resolve6 | tr '\n' ' ')"
  [ -n "${ips4// /}" ] || { echo "cannot resolve $PROXY_HOST (dig +short $PROXY_HOST A)" >&2; exit 1; }
  out="$(on_box bash -s -- "$(q "$PROXY_HOST")" "$(q "$ips4")" "$(q "$ips6")" <<'REMOTE'
set -euo pipefail
host="$1" ips4="$(xargs <<<"$2")" ips6="$(xargs <<<"$3")"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
# The box's own resolver may see other addresses (GeoDNS). Ask it before /etc/hosts changes the answer.
# Loopback and v4-mapped answers are this block's own mapping, not the proxy.
for ip in $(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u); do
  case "$ip" in
    127.*|::1|::ffff:*) ;;
    *:*) case " $ips6 " in *" $ip "*) ;; *) ips6="$ips6 $ip" ;; esac ;;
    *) case " $ips4 " in *" $ip "*) ;; *) ips4="$ips4 $ip" ;; esac ;;
  esac
done
command -v iptables >/dev/null || {
  apt-get -qq -o DPkg::Lock::Timeout=180 update >/dev/null && apt-get -qq -o DPkg::Lock::Timeout=180 install -y iptables >/dev/null
}
grep -q "^127\.0\.0\.1[[:space:]]$host\$" /etc/hosts || printf '127.0.0.1 %s\n' "$host" >>/etc/hosts
grep -q "^::1[[:space:]]$host\$" /etc/hosts || printf '::1 %s\n' "$host" >>/etc/hosts
# Docker sends container traffic through DOCKER-USER first. Make the chain now; a Docker that starts later reuses it.
iptables -S DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER
for ip in $ips4; do
  for chain in OUTPUT FORWARD DOCKER-USER; do
    iptables -C "$chain" -d "$ip" -j REJECT 2>/dev/null || iptables -I "$chain" 1 -d "$ip" -j REJECT
  done
done
for ip in $ips6; do
  for chain in OUTPUT FORWARD; do
    ip6tables -C "$chain" -d "$ip" -j REJECT 2>/dev/null || ip6tables -I "$chain" 1 -d "$ip" -j REJECT
  done
  ip6tables -S DOCKER-USER >/dev/null 2>&1 && { ip6tables -C DOCKER-USER -d "$ip" -j REJECT 2>/dev/null || ip6tables -I DOCKER-USER 1 -d "$ip" -j REJECT; }
done
grep -q '^export ANONYMIZED_TELEMETRY=false' ~/.bashrc 2>/dev/null || echo 'export ANONYMIZED_TELEMETRY=false' >>~/.bashrc
echo "blocked $host: /etc/hosts -> 127.0.0.1 and ::1, iptables REJECT in OUTPUT, FORWARD, DOCKER-USER for${ips4:+ $ips4}${ips6:+, ip6tables for $ips6}; ANONYMIZED_TELEMETRY=false in ~/.bashrc"
echo "ips4=$(xargs <<<"$ips4")"
echo "ips6=$(xargs <<<"$ips6")"
REMOTE
)"
  grep -v '^ips[46]=' <<<"$out"
  setkv PROXY_IPS "$(grep '^ips4=' <<<"$out" | cut -d= -f2-)"
  setkv PROXY_IPS6 "$(grep '^ips6=' <<<"$out" | cut -d= -f2-)"
}

cmd_check() {
  on_box bash -s -- "$(q "$PROXY_HOST")" "$(q "$(resolve4 | tr '\n' ' ')")" "$(q "$(resolve6 | tr '\n' ' ')")" <<'REMOTE'
set -u
host="$1" ips4="$2" ips6="$3" bad=0
# A probe passes only when the connection itself failed. A TLS alert (curl 35) or an HTTP status
# (curl 0, busybox wget "server returned error") means the box reached the proxy.
connect_fail="connection refused|couldn.t connect|can.t connect|failed to connect|timed out|unreachable|no route to host"
probe() {
  local label="$1" out rc=0
  shift
  out="$("$@" 2>&1)" || rc=$?
  out="$(tr '\n' ' ' <<<"$out" | sed -E 's/ +$//')"
  if [ "$rc" -ne 0 ] && grep -qiE "$connect_fail" <<<"$out"; then
    echo "ok   $label: exit $rc, $out"
  else
    echo "FAIL $label: exit $rc, ${out:-connected}"
    bad=1
  fi
}
rule() {  # rule <iptables|ip6tables> <chain> <ip>: the REJECT rule exists; prints its packet counter
  local tool="$1" chain="$2" ip="$3" pkts
  if "$tool" -C "$chain" -d "$ip" -j REJECT 2>/dev/null; then
    pkts="$("$tool" -L "$chain" -v -n -x 2>/dev/null | awk -v ip="$ip" '$3 == "REJECT" && index($0, ip) { print $1; exit }')"
    echo "ok   $tool $chain REJECT $ip (${pkts:-?} packets rejected so far)"
  else
    echo "FAIL $tool $chain has no REJECT rule for $ip"
    bad=1
  fi
}
[ -n "${ips4// /}" ] || { echo "FAIL no IPv4 address known for $host"; bad=1; }
echo "$host resolves on the box to: $(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
for ip in $ips4; do for chain in OUTPUT FORWARD DOCKER-USER; do rule iptables "$chain" "$ip"; done; done
for ip in $ips6; do for chain in OUTPUT FORWARD; do rule ip6tables "$chain" "$ip"; done; done
probe "host curl https://$host/v1/events by name (/etc/hosts)" curl -sS -m 8 -o /dev/null "https://$host/v1/events"
for ip in $ips4; do
  probe "host curl https://$host/v1/events at $ip (iptables OUTPUT)" curl -sS -m 8 -o /dev/null --resolve "$host:443:$ip" "https://$host/v1/events"
done
for ip in $ips6; do
  probe "host curl https://$host/v1/events at $ip (ip6tables OUTPUT)" curl -6 -sS -m 8 -o /dev/null --resolve "$host:443:[$ip]" "https://$host/v1/events"
done
if command -v docker >/dev/null; then
  docker pull -q alpine:3 >/dev/null 2>&1 || true
  probe "container wget https://$host/v1/events (FORWARD, DOCKER-USER)" docker run --rm alpine:3 wget -T 8 -q -O /dev/null "https://$host/v1/events"
else
  echo "skip container probe: no docker on the box"
fi
[ "$bad" -eq 0 ] && echo "block holds" || echo "BLOCK BROKEN: a probe reached the proxy, or a rule is missing (record.sh block, then check again)"
exit $bad
REMOTE
}

cmd_up() {
  local image="${1:-docker-ce}"
  if [ -f "$dir/run.env" ]; then
    echo "box exists ($dir/run.env), reusing it"
  else
    bash "$here/box.sh" up "$run" "$image"
  fi
  cmd_block
  on_box bash -s <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1
apt-get -qq -o DPkg::Lock::Timeout=180 update >/dev/null
apt-get -qq -o DPkg::Lock::Timeout=180 install -y unzip ttyd >/dev/null
# The package starts `ttyd login` on :7681 for everyone. The take runs its own ttyd on loopback (record.sh term).
systemctl disable --now ttyd >/dev/null 2>&1 || true
command -v script >/dev/null || { echo "no 'script' on the box (package bsdutils): the ttyd shell cannot log to ~/install.log" >&2; exit 1; }
echo "prepared: unzip, $(ttyd --version 2>&1 | head -1), packaged ttyd service off, $(script --version 2>&1 | head -1)"
REMOTE
  cmd_check
  echo "record box ready ($(bcn) BCN): record.sh term $run, then take.sh"
}

cmd_term() {
  local w="${1:-1280}" h="${2:-760}"
  on_box bash -s -- "$(q "$TTYD_PORT")" <<'REMOTE'
set -euo pipefail
port="$1"
cat >~/.record.bashrc <<'RC'
# Shell for the terminal take: the usual ~/.bashrc, then the look of the demo.
[ -f ~/.bashrc ] && . ~/.bashrc
export ANONYMIZED_TELEMETRY=false
HISTFILE=/dev/null
PS1='\[\e[38;2;106;115;125m\]\w \[\e[38;2;217;119;6m\]❯\[\e[0m\] '
RC
# What ttyd runs: the demo shell under `script`, which appends everything on screen to ~/install.log
# (-q: no "Script started" line on camera, -f: flush per write, so the file is readable during the take).
cat >~/.record-shell <<'SH'
#!/bin/bash
exec script -q -f -a -c "bash --rcfile $HOME/.record.bashrc" "$HOME/install.log"
SH
chmod 700 ~/.record-shell
pkill -f "^ttyd -p $port" 2>/dev/null || true
# GitHub-light palette on white. Menlo renders in the browser on the Mac, not on the box.
theme='{"background":"#ffffff","foreground":"#24292e","cursor":"#d97706","cursorAccent":"#ffffff","selectionBackground":"#fde68a","black":"#24292e","red":"#d73a49","green":"#22863a","yellow":"#b08800","blue":"#0366d6","magenta":"#6f42c1","cyan":"#1b7c83","white":"#6a737d","brightBlack":"#959da5","brightRed":"#cb2431","brightGreen":"#28a745","brightYellow":"#dbab09","brightBlue":"#2188ff","brightMagenta":"#8a63d2","brightCyan":"#3192aa","brightWhite":"#d1d5da"}'
setsid nohup ttyd -p "$port" -i lo -W -t fontFamily=Menlo -t fontSize=17 -t lineHeight=1.2 -t cursorBlink=true \
  -t disableLeaveAlert=true -t disableResizeOverlay=true -t "theme=$theme" \
  "$HOME/.record-shell" >~/.record-ttyd.log 2>&1 </dev/null &
for _ in $(seq 1 10); do curl -fsS -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null && break; sleep 0.5; done
curl -fsS -o /dev/null "http://127.0.0.1:$port/" || { cat ~/.record-ttyd.log; exit 1; }
echo "ttyd on the box loopback :$port, shell logged to ~/install.log"
REMOTE
  ssh -F "$dir/ssh_config" -S "$dir/ttyd.sock" -O exit box >/dev/null 2>&1 || true
  ssh -F "$dir/ssh_config" -M -S "$dir/ttyd.sock" -fN -o ExitOnForwardFailure=yes -L "$TTYD_PORT:127.0.0.1:$TTYD_PORT" box
  bash "$here/take.sh" open "http://127.0.0.1:$TTYD_PORT/" "$w" "$h"
  agent-browser wait --fn "document.querySelector('.xterm-screen') !== null" >/dev/null
  sleep 1
  # ttyd's first fit counts too many rows (the bottom lines fall off screen). A resize event fixes it.
  agent-browser eval "window.dispatchEvent(new Event('resize'))" >/dev/null
  agent-browser find first ".xterm-screen" click >/dev/null
  echo "terminal tab ready at ${w}x${h} @2x ($(bcn) BCN): take.sh start terminal, take.sh mark type, take.sh type ..."
}

cmd_term_stop() {
  ssh -F "$dir/ssh_config" -S "$dir/ttyd.sock" -O exit box >/dev/null 2>&1 && echo "forward closed" || true
  # ^ttyd: the cmdline of ttyd itself. The ssh wrapper of this very command starts with "bash", not "ttyd".
  on_box "pkill -f '^ttyd -p $TTYD_PORT' && echo 'ttyd stopped' || true" 2>/dev/null || true
}

cmd_down() {
  [ -f "$dir/ssh_config" ] && cmd_term_stop
  bash "$here/box.sh" down "$run"
}

run="${2:-}"
[[ "$run" =~ ^[a-z0-9][a-z0-9-]{2,40}$ ]] || usage
dir="/tmp/onboarding-qa-$run"
case "${1:-}" in
  up) cmd_up "${3:-}" ;;
  block) need_box; cmd_block ;;
  check) need_box; cmd_check ;;
  term) need_box; cmd_term "${3:-}" "${4:-}" ;;
  term-stop) need_box; cmd_term_stop ;;
  down) cmd_down ;;
  *) usage ;;
esac
