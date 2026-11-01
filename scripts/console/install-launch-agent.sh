#!/bin/zsh -f
# install-launch-agent.sh — runs the Console worker as a LaunchAgent in the
# owner's login session: it starts at login and is started again whenever
# it exits on an error (a lost lease, a store that cannot be written: the
# worker stops itself rather than let an agent work unrecorded). A clean
# stop (`launchctl kill TERM gui/<uid>/io.squadroom.console-worker`) exits
# 0 and is not restarted.
#
#   scripts/console/install-launch-agent.sh install   [checkout]   # default: this checkout
#   scripts/console/install-launch-agent.sh uninstall
#   scripts/console/install-launch-agent.sh status
#
# Run as the owner (not with sudo). Logs: ~/.squadroom/logs/console-worker.log.
# Stop any Console worker running in a terminal first: only one holds the lease.
set -eu

readonly LABEL=io.squadroom.console-worker
readonly PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
readonly LOG=$HOME/.squadroom/logs/console-worker.log
readonly DOMAIN=gui/$(/usr/bin/id -u)

die() { print -u2 -- "install-launch-agent: $*"; exit 1 }
[[ $(/usr/bin/id -u) != 0 ]] || die "run this as yourself, not with sudo"

case ${1-} in
  install)
    checkout=${2:-${0:A:h:h:h}}
    [[ -f $checkout/scripts/console-worker.ts ]] || die "not a checkout with scripts/console-worker.ts: $checkout"
    node=$(command -v node) || die "node not found on PATH"
    /bin/mkdir -p -m 700 ${LOG:h} ${PLIST:h}
    # Paths go into XML: escaped (& < > " ').
    xml() { local v=${1//&/&amp;}; v=${v//</&lt;}; v=${v//>/&gt;}; v=${v//\"/&quot;}; v=${v//\'/&apos;}; print -rn -- $v }
    x_node=$(xml $node) x_checkout=$(xml $checkout) x_log=$(xml $LOG) x_path=$(xml "${node:h}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    tmp=$(/usr/bin/mktemp)
    cat > $tmp <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$x_node</string><string>scripts/console-worker.ts</string></array>
  <key>WorkingDirectory</key><string>$x_checkout</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$x_path</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$x_log</string>
  <key>StandardErrorPath</key><string>$x_log</string>
</dict>
</plist>
EOF
    /usr/bin/plutil -lint $tmp >/dev/null || { /bin/rm -f $tmp; die "the plist did not validate"; }
    /bin/launchctl bootout $DOMAIN/$LABEL 2>/dev/null || true
    /bin/mv $tmp $PLIST
    /bin/chmod 644 $PLIST
    /bin/launchctl bootstrap $DOMAIN $PLIST
    print "Installed $LABEL for $checkout (log: $LOG)."
    ;;
  uninstall)
    /bin/launchctl bootout $DOMAIN/$LABEL 2>/dev/null || true
    /bin/rm -f $PLIST
    print "Removed $LABEL."
    ;;
  status)
    /bin/launchctl print $DOMAIN/$LABEL 2>/dev/null | /usr/bin/grep -E "state|pid|last exit" || print "$LABEL is not loaded."
    ;;
  *)
    die "usage: install [checkout] | uninstall | status"
    ;;
esac
