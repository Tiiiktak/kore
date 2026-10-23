#!/bin/bash
# kore web service control. Runs server.py as a bare background process.
# For everyday use prefer `kore server`; this is the systemd / bare-process path.
#
# Config (all overridable from the environment):
#   WB_PYTHON        python3 for the server
#   KORE_AGENT_TOKEN   server<->client agent secret  (fences /exec; enables register)
#   KORE_AGENTS_FILE   client-agent registry path    (default: ~/.kore/agents.json)
#   WB_HOST          bind address                       (default: 0.0.0.0)
#   WB_PORT          listen port                        (default: 8198)
#   WB_TOKEN_FILE    shared-token file                  (default: workbench/.token)
set -u

V="${WB_PYTHON:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDF="$HERE/.pid"
LOG="$HERE/server.log"

start() {
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    echo "already running (pid $(cat "$PIDF"))"; return 0
  fi
  cd "$HERE" || exit 1
  # Intranet agent traffic usually must NOT go through an HTTP proxy.
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
  export NO_PROXY="${NO_PROXY:-10.0.0.0/8,127.0.0.1,localhost}"
  export no_proxy="$NO_PROXY"

  # The agent token is the whole structural fence in front of a client agent's /exec
  # (arbitrary command execution on that node) and the client-join secret. Warn loudly if
  # it is unset — a client agent refuses to bind on a non-loopback address without it, and
  # the register door is disabled, so an unset token means no client can ever join.
  if [ -z "${KORE_AGENT_TOKEN:-}" ]; then
    echo "WARN: KORE_AGENT_TOKEN is unset; client agent auth is OFF and joins are disabled" >&2
  fi
  [ -n "${KORE_AGENT_TOKEN:-}" ] && export KORE_AGENT_TOKEN
  [ -n "${KORE_AGENTS_FILE:-}" ] && export KORE_AGENTS_FILE

  # 绑 0.0.0.0 是为了能从别的机器用浏览器访问。只有在 server.py 对除 /api/health 外的每个
  # 端点都强制 token 鉴权的前提下这才可接受 —— 这个端口同时承载写操作（start/stop/send/
  # keys/input/resize，即在任意节点上起/杀 claude 会话、往它的 pane 里打字），一个共享 token
  # 是唯一的围栏（POST 另需 Bearer 头 + 点名 node+session 的 confirm）。不要在保持 0.0.0.0
  # 的同时削弱这套鉴权。只在可信网段访问时可设 WB_HOST=127.0.0.1。
  export WB_HOST="${WB_HOST:-0.0.0.0}"
  export WB_PORT="${WB_PORT:-8198}"

  if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt $((16 * 1024 * 1024)) ]; then
    mv -f "$LOG" "$LOG.1"
  fi
  # No timeout/setsid wrapper: a group-wide SIGTERM would take the server with it.
  nohup "$V" "$HERE/server.py" >> "$LOG" 2>&1 &
  echo $! > "$PIDF"
  sleep 2
  if kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    echo "started pid $(cat "$PIDF") on $WB_HOST:$WB_PORT"
  else
    echo "FAILED to start; tail of log:"; tail -20 "$LOG"; return 1
  fi
}
stop() {
  [ -f "$PIDF" ] || { echo "not running"; return 0; }
  kill "$(cat "$PIDF")" 2>/dev/null
  rm -f "$PIDF"; echo "stopped"
}
status() {
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    echo "running pid $(cat "$PIDF")"
    curl -s --max-time 5 "http://127.0.0.1:${WB_PORT:-8198}/api/health" && echo
  else
    echo "not running"
  fi
}
case "${1:-}" in
  start) start;; stop) stop;; restart) stop; sleep 1; start;; status) status;;
  *) echo "usage: $0 {start|stop|restart|status}"; exit 1;;
esac
