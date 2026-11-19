#!/usr/bin/env bash
# Start or stop the Mailpit catcher used by the mail features (settings, invitations).
#   mailpit.sh up <rundir>    start a uniquely named container; writes <rundir>/mailpit.env
#   mailpit.sh down <rundir>  stop and remove the recorded container
# Ports are random and loopback-only, like the instance's own; nothing touches 1025/8025.
set -euo pipefail

CMD="${1:-}"
RUN_DIR="${2:-}"
[ -n "$RUN_DIR" ] || { echo "usage: $0 up|down <rundir>" >&2; exit 2; }

free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }

case "$CMD" in
up)
  if [ -f "$RUN_DIR/mailpit.env" ]; then
    # shellcheck disable=SC1091
    . "$RUN_DIR/mailpit.env"
    if [ "$(docker inspect -f '{{.State.Running}}' "$MAILPIT_CONTAINER" 2>/dev/null)" = true ]; then
      echo "MAILPIT_SMTP=$MAILPIT_SMTP"
      echo "MAILPIT_HTTP=$MAILPIT_HTTP"
      exit 0
    fi
  fi
  SMTP="$(free_port)"; HTTP="$(free_port)"
  NAME="orrery-verify-mailpit-$(basename "$RUN_DIR")"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -p "127.0.0.1:$SMTP:1025" -p "127.0.0.1:$HTTP:8025" \
    axllent/mailpit:v1.34.0 >/dev/null
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$HTTP/api/v1/messages" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$HTTP/api/v1/messages" >/dev/null
  cat >"$RUN_DIR/mailpit.env" <<EOF
MAILPIT_CONTAINER=$NAME
MAILPIT_SMTP=$SMTP
MAILPIT_HTTP=$HTTP
EOF
  echo "MAILPIT_SMTP=$SMTP"
  echo "MAILPIT_HTTP=$HTTP"
  ;;
down)
  if [ ! -f "$RUN_DIR/mailpit.env" ]; then
    echo "no mailpit recorded in $RUN_DIR"
    exit 0
  fi
  # shellcheck disable=SC1091
  . "$RUN_DIR/mailpit.env"
  docker rm -f "$MAILPIT_CONTAINER" >/dev/null 2>&1 || true
  rm -f "$RUN_DIR/mailpit.env"
  echo "stopped $MAILPIT_CONTAINER"
  ;;
*)
  echo "usage: $0 up|down <rundir>" >&2
  exit 2
  ;;
esac
