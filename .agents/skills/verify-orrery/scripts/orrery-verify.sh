#!/usr/bin/env bash
# Launch, check and tear down an isolated Orrery instance for verification.
#   orrery-verify.sh up              start Postgres (Docker) + the server; prints the run dir
#   orrery-verify.sh doctor <rundir> read-only health check of that instance
#   orrery-verify.sh down <rundir>   stop what `up` started; keeps <rundir>/evidence
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BASE="${ORRERY_VERIFY_BASE:-/tmp/orrery-verify}"

free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

load() {
  RUN_DIR="${1:?usage: $0 $CMD <rundir>}"
  [ -f "$RUN_DIR/env" ] || { echo "no instance at $RUN_DIR" >&2; exit 2; }
  # shellcheck disable=SC1091
  . "$RUN_DIR/env"
}

CMD="${1:-}"
case "$CMD" in
up)
  RUN="$(date +%Y%m%d-%H%M%S)-$$"
  RUN_DIR="$BASE/$RUN"
  mkdir -p "$RUN_DIR/evidence"
  PORT="$(free_port)"; PGPORT="$(free_port)"
  PGPASS="verify$RANDOM$RANDOM"
  CONTAINER="orrery-verify-$RUN"
  URL="http://localhost:$PORT"
  # Record names first so `down` can clean up even if a later step fails.
  cat >"$RUN_DIR/env" <<EOF
RUN_DIR=$RUN_DIR
PORT=$PORT
PGPORT=$PGPORT
CONTAINER=$CONTAINER
URL=$URL
EOF
  # 1. Postgres, throwaway, loopback only, random port (other containers may own 5432/8080/8081).
  docker run -d --name "$CONTAINER" -e POSTGRES_USER=orrery -e POSTGRES_PASSWORD="$PGPASS" \
    -e POSTGRES_DB=orrery -p "127.0.0.1:$PGPORT:5432" postgres:18 >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U orrery -d orrery >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$CONTAINER" pg_isready -U orrery -d orrery >/dev/null
  # 2. Web build into the run dir (never touches apps/web/dist).
  (cd "$ROOT" && pnpm --filter @orrery/web exec vite build --outDir "$RUN_DIR/web-dist" --emptyOutDir) \
    >"$RUN_DIR/web-build.log" 2>&1
  # 3. Server. PUBLIC_URL host must equal the host the client uses (MCP checks Host/Origin).
  # The subshell execs node, so the recorded pid is node's own.
  (
    cd "$ROOT/apps/server"
    export DATABASE_URL="postgres://orrery:$PGPASS@127.0.0.1:$PGPORT/orrery" PUBLIC_URL="$URL" PORT="$PORT" \
      WEB_DIST="$RUN_DIR/web-dist" LOG_LEVEL=info
    exec node src/main.ts >"$RUN_DIR/server.log" 2>&1 </dev/null
  ) &
  echo $! >"$RUN_DIR/server.pid"
  for _ in $(seq 1 30); do
    curl -fsS "$URL/readyz" >/dev/null 2>&1 && break
    kill -0 "$(cat "$RUN_DIR/server.pid")" 2>/dev/null || { echo "server exited; see $RUN_DIR/server.log" >&2; tail -20 "$RUN_DIR/server.log" >&2; exit 1; }
    sleep 1
  done
  curl -fsS "$URL/readyz" >/dev/null || { echo "server not ready; see $RUN_DIR/server.log" >&2; exit 1; }
  echo "RUN_DIR=$RUN_DIR"
  echo "URL=$URL"
  ;;

doctor)
  CMD=doctor; load "${2:-}"
  fail=0
  ok()  { echo "ok    $*"; }
  bad() { echo "FAIL  $*"; fail=1; }
  PID="$(cat "$RUN_DIR/server.pid" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && tr '\0' ' ' </proc/"$PID"/cmdline | grep -q 'src/main.ts'; then
    ok "server process $PID is up"
  else bad "server process not running (see $RUN_DIR/server.log)"; fi
  if ss -ltnp 2>/dev/null | grep -E ":$PORT\b" | grep -q "pid=$PID,"; then ok "port $PORT is owned by pid $PID"
  else bad "port $PORT is not owned by our server (another process may hold it)"; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; then ok "postgres container $CONTAINER running"
  else bad "postgres container $CONTAINER not running"; fi
  H="$(curl -fsS "$URL/healthz" 2>/dev/null || true)"; R="$(curl -fsS "$URL/readyz" 2>/dev/null || true)"
  case "$H" in *'"status":"ok"'*) ok "/healthz $H";; *) bad "/healthz: '$H'";; esac
  case "$R" in *'"status":"ok"'*) ok "/readyz $R";; *) bad "/readyz: '$R' (database unreachable?)";; esac
  curl -fsS "$URL/" 2>/dev/null | grep -q '<div id="root">' && ok "web app served at /" || bad "web app not served at /"
  [ -f "$RUN_DIR/web-dist/index.html" ] && ok "web build is from this run ($RUN_DIR/web-dist)" || bad "no web build"
  exit "$fail"
  ;;

down)
  CMD=down; load "${2:-}"
  if [ -f "$RUN_DIR/server.pid" ]; then
    PID="$(cat "$RUN_DIR/server.pid")"
    # Only kill the pid we recorded, and only if it is still our server.
    if kill -0 "$PID" 2>/dev/null && tr '\0' ' ' </proc/"$PID"/cmdline | grep -q 'src/main.ts'; then kill "$PID"; fi
  fi
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$RUN_DIR/web-dist"
  echo "stopped. evidence kept in $RUN_DIR/evidence"
  ;;

*) echo "usage: $0 up | doctor <rundir> | down <rundir>" >&2; exit 2 ;;
esac
