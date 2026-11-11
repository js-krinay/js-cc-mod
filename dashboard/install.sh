#!/bin/sh
# Runs the request-log dashboard (Bun) as a service on this machine. With
# Tailscale it is published to your tailnet at https://<machine>.<tailnet>.ts.net:8443/;
# without it, it answers on http://127.0.0.1:8787/ only.
#
#   install.sh [--enable-logging] [--port N] [--ts-port N] [--no-tailscale] [--peer URL ...]
#   install.sh [--enable-logging] --source-only
#   install.sh --uninstall
#
# --peer: this machine's dashboard also shows that machine's requests (its
#   https://<machine>.<tailnet>.ts.net:8443 address, or any URL it serves on).
# --source-only: this machine has no dashboard of its own; it serves its
#   rows to the main dashboard, which lists it with --peer.
# --no-tailscale: keep it on this machine even when Tailscale is installed.
#
# --enable-logging also adds the request-log mod to this machine's Claude Code
# settings, so new sessions log their requests. macOS: a launchd agent.
# Linux: a systemd user service (enable linger so it runs logged out).
# Rerunning replaces the service in place.
set -eu

PORT=8787
TS_PORT=8443
LABEL=cc.request-log.dashboard
DIR=$(cd "$(dirname "$0")" && pwd)
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
[ -x "$BUN" ] || { echo "bun is not installed (https://bun.sh)" >&2; exit 1; }
SERVER_ARGS=""
SOURCE=0
ENABLE=0
UNINSTALL=0
USE_TS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --ts-port) TS_PORT=$2; shift 2 ;;
    --no-tailscale) USE_TS=0; shift ;;
    --peer) SERVER_ARGS="$SERVER_ARGS --peer $2"; shift 2 ;;
    --source-only) SERVER_ARGS="$SERVER_ARGS --source-only"; SOURCE=1; shift ;;
    --enable-logging) ENABLE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

TS=""
if [ "$USE_TS" = 1 ]; then
  if command -v tailscale >/dev/null 2>&1; then TS=tailscale
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; fi
  # Installed but logged out or stopped counts as absent.
  [ -n "$TS" ] && ! "$TS" status >/dev/null 2>&1 && TS=""
fi
# Linux needs root to change serve config unless this user is the operator.
ts_serve() { "$TS" serve "$@" 2>/dev/null || sudo -n "$TS" serve "$@"; }
if [ -n "$TS" ]; then
  NAME=$("$TS" status --json | "$BUN" -e 'console.log(JSON.parse(await Bun.stdin.text()).Self.DNSName.replace(/\.$/, ""))')
  # The server answers data requests only for loopback or this machine's tailnet name.
  SERVER_ARGS="$SERVER_ARGS --host $NAME:$TS_PORT --host $NAME"
fi

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    if [ "$UNINSTALL" = 1 ]; then rm -f "$PLIST"
    else
      (cd "$DIR" && "$BUN" install --frozen-lockfile >/dev/null)
      mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
      ARGS=""
      for a in "$BUN" "$DIR/src/server.ts" --port "$PORT" $SERVER_ARGS; do ARGS="$ARGS    <string>$a</string>
"; done
      cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$ARGS  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/request-log-dashboard.log</string>
</dict>
</plist>
EOF
      launchctl bootstrap "gui/$(id -u)" "$PLIST"
    fi
    ;;
  Linux)
    UNIT="$HOME/.config/systemd/user/request-log-dashboard.service"
    systemctl --user disable --now request-log-dashboard.service 2>/dev/null || true
    if [ "$UNINSTALL" = 1 ]; then rm -f "$UNIT"; systemctl --user daemon-reload
    else
      (cd "$DIR" && "$BUN" install --frozen-lockfile >/dev/null)
      mkdir -p "$(dirname "$UNIT")"
      cat > "$UNIT" <<EOF
[Unit]
Description=request-log dashboard (127.0.0.1:$PORT)

[Service]
WorkingDirectory=$DIR
Environment=NODE_ENV=production
ExecStart=$BUN $DIR/src/server.ts --port $PORT$SERVER_ARGS
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable --now request-log-dashboard.service
    fi
    ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

if [ "$UNINSTALL" = 1 ]; then
  [ -n "$TS" ] && { ts_serve --https="$TS_PORT" off >/dev/null 2>&1 || true; }
  echo "removed the service${TS:+ and its tailnet port}"
  exit 0
fi

if [ "$ENABLE" = 1 ]; then "$BUN" "$DIR/scripts/enable-logging.ts"; fi

# Tailnet only (serve, never funnel), on its own port: the page's bundled
# assets load from the site root, which a sub-path mount would break.
[ -n "$TS" ] && ts_serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT" >/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/api/export?limit=1" && break
  sleep 1
done
URL=${TS:+https://$NAME:$TS_PORT/}
URL=${URL:-http://127.0.0.1:$PORT/}
if [ "$SOURCE" = 1 ]; then echo "source only: $URL serves its rows to the main dashboard"
else echo "dashboard: $URL${TS:+ (your tailnet)}"; fi
[ -z "$TS" ] && echo "Tailscale is not running here, so only this machine can open it." || true
