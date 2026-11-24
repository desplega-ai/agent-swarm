#!/usr/bin/env bash
# PostgreSQL extras for a stack made with `stack.sh up ... --overlay postgres`.
#
#   stack-pg.sh reader <run>   create the restricted db-query role (runbooks/postgres.md), set
#                              DATABASE_QUERY_URL in the stack .env, recreate the API, print its probe lines
#   stack-pg.sh backup <run>   install a daily `pg_dump --format=custom` on the box (systemd timer,
#                              02:30 UTC, /var/backups/<run>/, the newest 7 files stay), run it once
#                              and check the file with `pg_restore --list`
#
# Both are safe to run again. The reader password is generated on the box and never leaves it.
# The dumps stay on the box disk: they protect against a bad write, not against a lost box.
set -euo pipefail

usage() { sed -n '2,11p' "$0"; exit 2; }

run="${2:-}"
[[ "$run" =~ ^[a-z0-9][a-z0-9-]{2,40}$ ]] || usage
cfg="/tmp/onboarding-qa-$run/ssh_config"
[ -f "$cfg" ] || { echo "no ssh config at $cfg (stack.sh up first)" >&2; exit 2; }

cmd_reader() {
  ssh -F "$cfg" box bash -s <<'REMOTE'
set -euo pipefail
cd ~/swarm && umask 077
setkv() { { grep -v "^$1=" .env || true; printf '%s=%s\n' "$1" "$2"; } >.env.tmp && mv .env.tmp .env; }
getkv() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
[ -n "$(getkv POSTGRES_PASSWORD)" ] || { echo "no POSTGRES_PASSWORD in .env: the stack has no postgres overlay" >&2; exit 2; }
pw="$(getkv POSTGRES_READER_PASSWORD)"
[ -n "$pw" ] || { pw="$(openssl rand -hex 24)"; setkv POSTGRES_READER_PASSWORD "$pw"; }
# One transaction: the role never sees the denied tables between the GRANT and the REVOKE.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -q -U swarm -d swarm <<SQL
BEGIN;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'swarm_reader') THEN
    CREATE ROLE swarm_reader LOGIN;
  END IF;
END \$\$;
ALTER ROLE swarm_reader PASSWORD '$pw';
GRANT CONNECT ON DATABASE swarm TO swarm_reader;
GRANT USAGE ON SCHEMA public TO swarm_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO swarm_reader;
REVOKE SELECT ON oauth_authorizations, oauth_apps, oauth_pending, user_tokens,
  session_tokens, script_apis, codex_oauth_device_flows FROM swarm_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE swarm IN SCHEMA public GRANT SELECT ON TABLES TO swarm_reader;
COMMIT;
SQL
setkv DATABASE_QUERY_URL "postgres://swarm_reader:$pw@postgres:5432/swarm"
chmod 600 .env
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose up -d api >/dev/null 2>&1
for _ in $(seq 1 36); do
  curl -fsS -m 5 -o /dev/null http://127.0.0.1:3013/health 2>/dev/null && break
  sleep 5
done
curl -fsS -m 5 -o /dev/null http://127.0.0.1:3013/health || { echo "the API did not come back after 3 min" >&2; exit 1; }
echo "reader role swarm_reader ready, DATABASE_QUERY_URL set, API recreated. db-query lines since then:"
docker compose logs --no-log-prefix --since "$since" api 2>/dev/null | grep -i 'db-query' | cut -c1-240 || echo "  (none: an API with no db-query line passed the probe)"
REMOTE
}

cmd_backup() {
  ssh -F "$cfg" box bash -s -- "$run" <<'REMOTE'
set -euo pipefail
run="$1"
install -d -m 700 "/var/backups/$run"
cat >/usr/local/bin/swarm-pg-backup <<'EOF'
#!/usr/bin/env bash
# pg_dump of the swarm database (stack-pg.sh backup). Keeps the newest <keep> files.
set -euo pipefail
dir="$1" keep="${2:-7}"
cd /root/swarm
out="$dir/swarm-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f "$out.part"' EXIT
docker compose exec -T postgres pg_dump -U swarm -d swarm --format=custom >"$out.part"
# A dump that pg_restore cannot list is not a backup.
docker compose exec -T postgres pg_restore --list <"$out.part" >/dev/null
mv "$out.part" "$out"
find "$dir" -maxdepth 1 -name 'swarm-*.dump' -printf '%T@ %p\n' | sort -rn | tail -n "+$((keep + 1))" |
  cut -d' ' -f2- | xargs -r rm -f --
echo "backup ok: $out ($(du -h "$out" | cut -f1)), $(find "$dir" -maxdepth 1 -name 'swarm-*.dump' | wc -l) kept"
EOF
chmod 755 /usr/local/bin/swarm-pg-backup
cat >/etc/systemd/system/swarm-pg-backup.service <<EOF
[Unit]
Description=pg_dump of the swarm PostgreSQL database
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
UMask=0077
Environment=HOME=/root
ExecStart=/usr/local/bin/swarm-pg-backup /var/backups/$run 7
EOF
cat >/etc/systemd/system/swarm-pg-backup.timer <<'EOF'
[Unit]
Description=Daily pg_dump of the swarm PostgreSQL database

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now swarm-pg-backup.timer >/dev/null 2>&1
systemctl start swarm-pg-backup.service
journalctl -u swarm-pg-backup.service -n 5 --no-pager -o cat | grep 'backup ok' | tail -1
newest="$(find "/var/backups/$run" -maxdepth 1 -name 'swarm-*.dump' -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
toc="$(cd /root/swarm && docker compose exec -T postgres pg_restore --list <"$newest")"
echo "pg_restore --list: $(grep -c ' TABLE DATA ' <<<"$toc") tables with data, $(grep -c ' INDEX ' <<<"$toc") indexes"
systemctl list-timers swarm-pg-backup.timer --no-pager | sed -n '1,2p'
REMOTE
}

case "${1:-}" in
  reader) cmd_reader ;;
  backup) cmd_backup ;;
  *) usage ;;
esac
