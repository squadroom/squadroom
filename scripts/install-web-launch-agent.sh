#!/bin/zsh -f
# install-web-launch-agent.sh — runs the signed-in web server (the Console's
# pages and the sign-in: `npm run web`, the built `next start`) as a
# LaunchAgent in the owner's login session, beside the Console worker's
# (scripts/console/install-launch-agent.sh). It starts at login and is
# started again whenever it stops by itself (a crash, a build missing or of
# another commit: see the log). A stop asked for (`stop`, `uninstall`)
# exits 0 and is not restarted.
#
#   scripts/install-web-launch-agent.sh install [--port N] [checkout]   # default: 3011, this checkout
#   scripts/install-web-launch-agent.sh stop | start | restart | status | uninstall
#
# Run as yourself (not with sudo), after `npm run build`. Stop any
# `npm run web` running in a terminal first: only one server can hold the
# port. Logs: ~/.squadroom/logs/web.log. Settings come from the checkout's
# .env files only: a LaunchAgent does not read your shell profile.
set -eu

readonly LABEL=io.squadroom.web
readonly PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
readonly LOG=$HOME/.squadroom/logs/web.log
readonly DOMAIN=gui/$(/usr/bin/id -u)

die() { print -u2 -- "install-web-launch-agent: $*"; exit 1 }
[[ $(/usr/bin/id -u) != 0 ]] || die "run this as yourself, not with sudo"
loaded() { /bin/launchctl print $DOMAIN/$LABEL >/dev/null 2>&1 }
# `bootout` returns before the job is gone: it stops the server first
# (SIGTERM), so the unload is waited for, up to 30 seconds.
unloaded() {
  local i
  for i in {1..30}; do loaded || return 0; sleep 1; done
  ! loaded
}

case ${1-} in
  install)
    shift
    port=3011
    if [[ ${1-} == --port ]]; then
      [[ ${2-} == <1-65535> ]] || die "--port needs a port number"
      port=$2
      shift 2
    fi
    # Absolute: launchd resolves WorkingDirectory in its own context.
    checkout=${${1:-${0:A:h:h}}:A}
    [[ -f $checkout/scripts/web.ts ]] || die "not a checkout with scripts/web.ts: $checkout"
    [[ -f $checkout/.next/squadroom-build.json ]] || die "no build in $checkout: run npm run build there first"
    node=$(command -v node) || die "node not found on PATH"
    /bin/mkdir -p -m 700 ${LOG:h}
    /bin/mkdir -p ${PLIST:h}
    # Paths go into XML: escaped (& < > " ').
    xml() { local v=${1//&/&amp;}; v=${v//</&lt;}; v=${v//>/&gt;}; v=${v//\"/&quot;}; v=${v//\'/&apos;}; print -rn -- $v }
    # git and node come from here.
    x_node=$(xml $node) x_checkout=$(xml $checkout) x_log=$(xml $LOG) x_path=$(xml "${node:h}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    tmp=$(/usr/bin/mktemp)
    cat > $tmp <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$x_node</string><string>scripts/web.ts</string><string>--port</string><string>$port</string></array>
  <key>WorkingDirectory</key><string>$x_checkout</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$x_path</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$x_log</string>
  <key>StandardErrorPath</key><string>$x_log</string>
</dict>
</plist>
EOF
    /usr/bin/plutil -lint $tmp >/dev/null || { /bin/rm -f $tmp; die "the plist did not validate"; }
    # The old job is unloaded first, or nothing is replaced.
    if loaded; then
      /bin/launchctl bootout $DOMAIN/$LABEL || { /bin/rm -f $tmp; die "could not stop the installed $LABEL; nothing was changed"; }
      unloaded || { /bin/rm -f $tmp; die "$LABEL is still loaded; nothing was changed"; }
    fi
    /bin/mv $tmp $PLIST
    /bin/chmod 644 $PLIST
    /bin/launchctl bootstrap $DOMAIN $PLIST
    print "Installed $LABEL for $checkout on 127.0.0.1:$port (log: $LOG)."
    ;;
  stop)
    # Unloaded until `start` (or the next login): a stop is not restarted.
    # A failure to unload a loaded job is an error (the update builds next).
    if loaded; then
      /bin/launchctl bootout $DOMAIN/$LABEL || die "could not stop $LABEL"
      unloaded || die "$LABEL is still loaded"
    fi
    print "Stopped $LABEL."
    ;;
  start)
    [[ -f $PLIST ]] || die "$LABEL is not installed: run install first"
    # Loaded but not running (it was sent a stop that exited cleanly):
    # kick-started; a running job is left as it is.
    if loaded; then /bin/launchctl kickstart $DOMAIN/$LABEL; else /bin/launchctl bootstrap $DOMAIN $PLIST; fi
    print "Started $LABEL."
    ;;
  restart)
    [[ -f $PLIST ]] || die "$LABEL is not installed: run install first"
    if loaded; then /bin/launchctl kickstart -k $DOMAIN/$LABEL; else /bin/launchctl bootstrap $DOMAIN $PLIST; fi
    print "Restarted $LABEL."
    ;;
  uninstall)
    # The plist goes only once the job is unloaded.
    if loaded; then
      /bin/launchctl bootout $DOMAIN/$LABEL || die "could not stop $LABEL; its plist is kept"
      unloaded || die "$LABEL is still loaded; its plist is kept"
    fi
    /bin/rm -f $PLIST
    print "Removed $LABEL."
    ;;
  status)
    /bin/launchctl print $DOMAIN/$LABEL 2>/dev/null | /usr/bin/grep -E "state|pid|last exit" || print "$LABEL is not loaded."
    ;;
  *)
    die "usage: install [--port N] [checkout] | stop | start | restart | status | uninstall"
    ;;
esac
