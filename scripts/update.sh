#!/bin/zsh -f
# update.sh — `npm run update`: brings this checkout up to date and serves
# the new build. In order:
#
#   1. refuses with a built server running from a terminal here, and with
#      local changes (untracked files included: a build would serve them
#      under the pulled commit's stamp);
#   2. pulls (fast-forward only);
#   3. stops the web LaunchAgent (io.squadroom.web) when it runs: both
#      `npm ci` and a build replace files a running `next start` loads;
#   4. `npm ci` when package-lock.json changed since the build being served
#      (or node_modules is missing, or that is not known);
#   5. `npm run build`;
#   6. starts the web LaunchAgent again.
#
# "Since the build being served" is the commit in its stamp
# (.next/squadroom-build.json), so a run after a failed one still installs
# and still reports what changed. The web server (the Console's pages and
# the sign-in) is down from step 3 to step 6 (a minute or two). The Console
# worker is not touched: its agents keep running. When the update changed
# the worker's code, the script says so and how to restart it. Do that when
# no turn is running: a restart interrupts running turns, which then wait
# for you in Needs you.
set -eu

die() { print -u2 -- "update: $*"; exit 1 }
[[ $(/usr/bin/id -u) != 0 ]] || die "run this as yourself, not with sudo"
cd ${0:A:h:h}
readonly ROOT=$PWD
readonly WEB=$ROOT/scripts/install-web-launch-agent.sh
readonly LABEL=io.squadroom.web
readonly DOMAIN=gui/$(/usr/bin/id -u)
readonly PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
# Inside Git's own folder, for a plain clone and a linked worktree alike.
readonly FROM=${$(git rev-parse --git-path squadroom-update-from):A}
# The web LaunchAgent counts as this checkout's only when its plist names
# this checkout; one installed for another checkout is left alone.
ours=0
if [[ -f $PLIST && $(/usr/bin/plutil -extract WorkingDirectory raw -o - $PLIST 2>/dev/null) == $ROOT ]]; then ours=1; fi
loaded() { /bin/launchctl print $DOMAIN/$LABEL >/dev/null 2>&1 }
# How the web server is started again after going back to where the update
# started (the recovery command printed on a failure below).
if (( ours )); then restart="zsh $WEB start"; else restart="npm run web -- --port 3011"; fi
agent_pid() { /bin/launchctl print $DOMAIN/$LABEL 2>/dev/null | /usr/bin/awk '$1 == "pid" { print $3; exit }' }
# Built servers serving this checkout, except the LaunchAgent's own.
others() {
  local agent=$( (( ours )) && agent_pid ) pid
  for pid in $(/usr/bin/pgrep -f "$ROOT/node_modules/next/dist/bin/next start"); do
    [[ -n $agent && $(/bin/ps -o ppid= -p $pid | tr -d ' ') == $agent ]] || print $pid
  done
}

branch=$(git symbolic-ref --quiet --short HEAD) || die "this checkout is not on a branch (detached HEAD): git switch to its branch first"

[[ -z $(git status --porcelain) ]] || die "this checkout has local changes or untracked files (git status); commit, remove or ignore them first"

# A built server started from a terminal in this checkout would break
# while its files are replaced: refused before anything changes.
[[ -z $(others) ]] || die "a built web server runs from this checkout outside its LaunchAgent (a terminal npm run web?): stop it first"

# The commit of the build being served, if it is known.
deployed=$(node -e 'try { const s = JSON.parse(require("fs").readFileSync(".next/squadroom-build.json", "utf8")); if (typeof s.commit === "string") process.stdout.write(s.commit) } catch {}')
before=$(git rev-parse HEAD)
# Where this update started, kept until one succeeds, so a retry after a
# failure still offers the way back to it.
[[ -f $FROM ]] || print $before > $FROM
from=$(<$FROM)
git pull --ff-only
after=$(git rev-parse HEAD)
if [[ $before == $after ]]; then
  print "Already up to date at ${after[1,12]}."
else
  print "Updated ${before[1,12]} → ${after[1,12]}."
fi
# Changed since the build being served; when that is not known, assume so.
changed() {
  [[ -z $deployed ]] && return 0
  git cat-file -e "$deployed^{commit}" 2>/dev/null || return 0
  [[ -n $(git diff --name-only $deployed $after -- "$@") ]]
}

if (( ours )) && loaded; then
  zsh $WEB stop
elif [[ -f $PLIST ]] && (( ! ours )); then
  print "Note: the web LaunchAgent serves another checkout; it is left as it is."
fi
# The LaunchAgent's server is given 20 seconds to exit; anything still
# serving this checkout then is not replaced underneath it. The LaunchAgent
# stays stopped: its build no longer matches the pulled commit.
for _ in {1..20}; do [[ -z $(/usr/bin/pgrep -f "$ROOT/node_modules/next/dist/bin/next start") ]] && break; sleep 1; done
[[ -z $(/usr/bin/pgrep -f "$ROOT/node_modules/next/dist/bin/next start") ]] || die "a built web server still runs from this checkout: stop it, then run this again (the web LaunchAgent stays stopped meanwhile)"

if [[ ! -d node_modules ]] || changed package-lock.json; then
  if ! npm ci --no-audit --no-fund; then
    print -u2 -- "update: npm ci failed; the web server stays stopped."
    print -u2 -- "  Fix it and run this again, or go back to where this update started, keeping the branch:"
    print -u2 -- "  git reset --keep ${from[1,12]} && /bin/rm -f $FROM && npm ci && npm run build && $restart"
    exit 1
  fi
fi

if ! npm run build; then
  print -u2 -- "update: the build failed; the web server stays stopped."
  print -u2 -- "  Fix it and run this again, or go back to where this update started, keeping the branch:"
  print -u2 -- "  git reset --keep ${from[1,12]} && /bin/rm -f $FROM && npm ci && npm run build && $restart"
  exit 1
fi

# The worker imports across src/lib and src/config (the shared modules
# included), so any change there may affect it.
if changed src/lib src/config scripts/console-worker.ts scripts/console package.json package-lock.json; then
  print "The Console worker's code may have changed. When no Console turn is running, restart it:"
  print "  launchctl kickstart -k $DOMAIN/io.squadroom.console-worker"
  if changed scripts/console/console-agent scripts/console/setup-agent-user.sh; then
    print "The launcher or the agent user's setup may have changed too: see docs/setup.md (the sudo step)."
  fi
fi

/bin/rm -f $FROM
if (( ours )); then
  zsh $WEB start
else
  print "Built. Start the web server: zsh $WEB install --port 3011  (or npm run web -- --port 3011 in a terminal)."
fi
