#!/usr/bin/env bash
set -euo pipefail

# Deploy tester-huester to hermes, per DEPLOY.md. Backs the LIVE database up first: this release migrates
# every existing row's status, and a migration without a way back is a bet, not a deploy.
HOST=ubuntu@84.235.175.42
KEY=/c/Users/iphot/.ssh/oracle_hermes.key
SSH="ssh -o BatchMode=yes -i $KEY $HOST"
STAMP=$(date +%Y%m%d-%H%M%S)

echo "== backup =="
$SSH "cd ~/tester-huester && docker compose exec -T web sh -c 'mkdir -p /data/backup && cp /data/th.db /data/backup/th.db.$STAMP && ls -la /data/backup/th.db.$STAMP'"

echo "== ship =="
tar --exclude=node_modules --exclude=.next --exclude=.turbo --exclude=.wxt \
    --exclude=.data --exclude='th.db*' --exclude=.git \
    -czf - . | $SSH 'mkdir -p ~/tester-huester && tar -xzf - -C ~/tester-huester'

echo "== build =="
# The onboarding doc is GENERATED from the same module the servers use. Nothing pulled this gate, so the
# doc could silently drift back into being a stale hand-written copy - exactly the defect it replaced.
# A deploy is the last honest moment to catch it: refuse to ship a tree whose doc no longer matches.
echo "== onboarding doc up to date? =="
pnpm --filter @th/mcp docs --check

$SSH 'cd ~/tester-huester && docker compose up -d --build' 2>&1 | tail -25

# Wait on an endpoint that OPENS THE DATABASE, not on "/". Migrations are lazy (ensureSchema runs on the
# first DB access) and "/" is a 307 to /login that never touches sqlite - so a deploy could report success over
# an UNMIGRATED database and the first agent request would pay the cost. /api/agents forces it now.
# 100 polls, not 40: the container fetches pnpm through corepack on every start and can outlast two minutes,
# and a wait that cries wolf is worse than no wait at all.
echo "== wait for ready (forces the lazy migration) =="
for i in $(seq 1 100); do
  # `set -e` kills the script on a non-zero exit, so the assignment MUST carry its own fallback — but as
  # `|| code=000`, not `|| echo 000`: the echo APPENDED a second 000 to the one curl already prints, and
  # the guard then compared "000000" != "000" -> true -> the loop exited on its first pass. One form
  # crashes the script, the other silently skips the wait. Both looked like "health: 000".
  code=$($SSH 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4319/api/agents' 2>/dev/null) || code=000
  [ "$code" != "000" ] && break
  sleep 3
done

# The loop above is the ONLY readiness signal. Printing a second, independent curl here is how "health: 000"
# appeared on a perfectly healthy deploy: the container answered a moment after the line was printed. Report
# what the wait actually observed, and FAIL LOUDLY if it never observed anything - a wait that cries wolf is
# indistinguishable from the run where it matters.
if [ "$code" = "000" ]; then
  echo "ГОТОВНОСТЬ НЕ ПОДТВЕРЖДЕНА: за $((100*3)) с сервер не ответил ни разу. Выкладка НЕ доказана."
  $SSH "cd ~/tester-huester && docker compose logs --tail 30 web"
  exit 1
fi
echo "health (/api/agents, база открыта и мигрирована): $code"
echo "public: $($SSH 'curl -s -o /dev/null -w "%{http_code}" https://qa.ihor.work/')"
echo "backup: /data/backup/th.db.$STAMP"
