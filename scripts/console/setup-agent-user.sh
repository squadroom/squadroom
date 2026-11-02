#!/bin/zsh -f
# setup-agent-user.sh: creates the `agent` macOS user, installs the pinned
# agent programs and the launcher, and checks the boundary. Run once from
# the owner's account, in the repository folder:
#
#   sudo zsh scripts/console/setup-agent-user.sh [--force]
#
# Safe to run again: every step checks what already exists. Stop the
# Console worker first: while agent programs run, it refuses (--force stops
# them all, ending their turns). It changes nothing in the owner's account
# except adding the owner to the `agent` group, so the owner can read
# agents' work.
set -eu
umask 022

readonly AGENT=agent
readonly ID=600
# The agent host's paths. Each can be moved with the same name the Console
# worker reads (sudo CONSOLE_SHARED=… zsh …); they are baked into the
# installed launcher, which cannot read the worker's environment.
readonly AGENT_HOME=${CONSOLE_AGENT_HOME:-/Users/$AGENT}
readonly CLIENTS=${CONSOLE_CLIENTS_DIR:-/opt/console-clients}
readonly LAUNCHER=${CONSOLE_LAUNCHER:-/usr/local/libexec/console-agent}
readonly SUDOERS=/etc/sudoers.d/console-agent
readonly SHARED=${CONSOLE_SHARED:-/opt/console-shared}
readonly HERE=${0:A:h}

step() { print -P "%B==> $*%b" }
fail() { print -u2 -P "%F{red}Stopped:%f $*"; exit 1 }
warn() { print -u2 -P "%F{yellow}Warning:%f $*" }

(( EUID == 0 )) || fail "run with sudo: sudo zsh scripts/console/setup-agent-user.sh"
readonly OWNER=${SUDO_USER-}
[[ -n $OWNER && $OWNER != root ]] || fail "run with sudo from your own account, not as root"
[[ -f $HERE/console-agent ]] || fail "run from the repository (scripts/console/console-agent is missing)"
force=0
for arg in "$@"; do
  [[ $arg == --force ]] && force=1 || fail "unknown option '$arg' (the only option is --force)"
done
# The paths are baked into the launcher with sed and into sudoers: plain
# absolute paths only.
for dir in $AGENT_HOME $CLIENTS $LAUNCHER $SHARED; do
  [[ $dir =~ '^/[A-Za-z0-9._/-]+$' ]] || fail "$dir: use a plain absolute path (letters, digits, . _ - /)"
done

# The Console worker restarts itself (its LaunchAgent) and, each time it
# stops, ends every '$AGENT' process: that would kill the installs below.
# It is stopped for the length of setup and started again on exit, even when
# setup fails, so a failed run never leaves it off.
readonly OWNER_UID=$(/usr/bin/id -u $OWNER)
readonly WORKER=gui/$OWNER_UID/io.squadroom.console-worker
readonly WORKER_PLIST=$(/usr/bin/dscl . -read /Users/$OWNER NFSHomeDirectory | /usr/bin/awk '{print $2}')/Library/LaunchAgents/io.squadroom.console-worker.plist
worker_was_on=0
/bin/launchctl print $WORKER >/dev/null 2>&1 && worker_was_on=1
restart_worker() {
  (( worker_was_on )) && [[ -f $WORKER_PLIST ]] || return 0
  /bin/launchctl bootstrap gui/$OWNER_UID $WORKER_PLIST 2>/dev/null || /bin/launchctl kickstart $WORKER 2>/dev/null || true
  print "  the Console worker is started again"
}

# Agent programs running now would lose their files and folders mid-turn.
# Only the agents' own programs count: macOS runs a few of its own for any
# account in use (distnoted, cfprefsd and the like, from /usr or /System).
agent_programs() {
  /bin/ps -U $AGENT -o comm= 2>/dev/null | /usr/bin/grep -Ev '^(/usr/(sbin|libexec|bin)/|/System/)' || true
}
if /usr/bin/id $AGENT >/dev/null 2>&1 && running=$(agent_programs) && [[ -n $running ]]; then
  (( force )) || fail "${#${(f)running}} '$AGENT' programs are running (Console turns). Let them finish, then run this again. --force stops them all now, ending their turns."
  warn "--force: stopping ${#${(f)running}} running '$AGENT' programs"
fi
if (( worker_was_on )); then
  step "Stopping the Console worker until setup ends"
  trap restart_worker EXIT
  /bin/launchctl bootout $WORKER 2>/dev/null || true
fi

# Node 24 or newer: it reads the pinned versions, installs the clients, and
# its folder goes on the agents' PATH. Homebrew's node@24 is keg-only (not
# linked into bin), so its keg is looked in too, then wherever your own
# shell finds `node`.
owner_shell=$(/usr/bin/dscl . -read /Users/$OWNER UserShell | /usr/bin/awk '{print $2}')
[[ $owner_shell == /* && -x $owner_shell ]] || owner_shell=/bin/zsh
owner_node=$(cd / && /usr/bin/sudo -u $OWNER -H $owner_shell -ilc 'command -v node' </dev/null 2>/dev/null | /usr/bin/tail -1) || true
node=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node $owner_node; do
  [[ $candidate == /* && -x $candidate && -x ${candidate:h}/npm ]] || continue
  (( $($candidate -p 'process.versions.node.split(".")[0]' 2>/dev/null || print 0) >= 24 )) && { node=$candidate; break; }
done
[[ -n $node ]] || fail "no Node 24 or newer found (in /opt/homebrew/bin, /usr/local/bin, Homebrew's node@24, or on your PATH); install it first: brew install node@24"
readonly NODE_BIN=${node:h}
[[ $NODE_BIN =~ '^/[A-Za-z0-9._/@+-]+$' ]] || fail "$NODE_BIN: Node's folder must be a plain path"
print "Using Node $($node --version) from $NODE_BIN"

# The pinned versions, from their one source (src/lib/console/clients.ts).
versions=($($node --no-warnings --input-type=module -e 'const { CLIENT_VERSIONS: v } = await import(process.argv[1]); console.log(v.claude, v.codex);' "file://${HERE:h:h}/src/lib/console/clients.ts")) ||
  fail "could not read the pinned versions from src/lib/console/clients.ts"
readonly CLAUDE_VERSION=${versions[1]} CODEX_VERSION=${versions[2]}
[[ $CLAUDE_VERSION == <->.<->.<-> && $CODEX_VERSION == <->.<->.<-> ]] || fail "src/lib/console/clients.ts did not give two versions"
# The ACP clients: package, version and executable, one per line.
acp_clients=("${(@f)$($node --no-warnings --input-type=module -e 'const { ACP_CLIENTS: a } = await import(process.argv[1]); for (const [name, c] of Object.entries(a)) console.log(`${c.package} ${c.version} ${name}`);' "file://${HERE:h:h}/src/lib/console/clients.ts")}") ||
  fail "could not read the ACP clients from src/lib/console/clients.ts"
for line in $acp_clients; do
  [[ $line =~ '^(@[a-z0-9-]+/)?[a-z0-9-]+ [0-9]+\.[0-9]+\.[0-9]+ [a-z]+$' ]] || fail "src/lib/console/clients.ts gave an ACP client this script does not understand: $line"
done

step "Checking free disk space"
free_gb=$(( $(/bin/df -k /System/Volumes/Data | /usr/bin/awk 'NR==2 {print $4}') / 1024 / 1024 ))
print "  $free_gb GB free"
(( free_gb >= 10 )) || warn "only $free_gb GB is free; about 10 GB is plenty, so you may run short"

step "Group '$AGENT' (id $ID)"
if /usr/bin/dscl . -read /Groups/$AGENT >/dev/null 2>&1; then
  [[ $(/usr/bin/dscl . -read /Groups/$AGENT PrimaryGroupID 2>/dev/null | /usr/bin/awk '{print $2}') == $ID ]] ||
    fail "a group named '$AGENT' exists but its id is not $ID; remove or rename it first"
  members=$(/usr/bin/dscl . -read /Groups/$AGENT GroupMembership 2>/dev/null | /usr/bin/cut -d: -f2- | /usr/bin/xargs)
  for member in ${(z)members}; do
    [[ $member == $OWNER ]] || fail "group '$AGENT' has an unexpected member '$member'; remove it first"
  done
  # Members can also be recorded by UUID or as whole nested groups.
  [[ -z $(/usr/bin/dscl . -read /Groups/$AGENT NestedGroups 2>/dev/null) ]] ||
    fail "group '$AGENT' contains nested groups; remove them first"
  owner_uuid=$(/usr/bin/dscl . -read /Users/$OWNER GeneratedUID | /usr/bin/awk '{print $2}')
  uuids=$(/usr/bin/dscl . -read /Groups/$AGENT GroupMembers 2>/dev/null | /usr/bin/cut -d: -f2- | /usr/bin/xargs)
  for uuid in ${(z)uuids}; do
    [[ $uuid == $owner_uuid ]] || fail "group '$AGENT' has an unexpected member ($uuid); remove it first"
  done
  print "  exists and matches"
else
  [[ -z $(/usr/bin/dscl . -list /Groups PrimaryGroupID | /usr/bin/awk -v id=$ID '$2 == id') ]] ||
    fail "group id $ID is taken"
  /usr/bin/dscl . -create /Groups/$AGENT
  /usr/bin/dscl . -create /Groups/$AGENT PrimaryGroupID $ID
  /usr/bin/dscl . -create /Groups/$AGENT RealName "Console agents"
  print "  created"
fi

step "User '$AGENT' (id $ID, hidden, its own group, not 'staff' or 'admin')"
attr() { /usr/bin/dscl . -read /Users/$AGENT $1 2>/dev/null | /usr/bin/awk '{print $2}' }
if /usr/bin/id $AGENT >/dev/null 2>&1; then
  # An existing account must be exactly the dedicated one; anything else is
  # refused rather than reused (another person's account, a half-made one).
  [[ $(attr UniqueID) == $ID && $(attr PrimaryGroupID) == $ID && $(attr NFSHomeDirectory) == $AGENT_HOME ]] ||
    fail "an account named '$AGENT' exists but is not the Console's (id, group or home differ); remove or rename it first"
  print "  exists and matches"
else
  [[ -z $(/usr/bin/dscl . -list /Users UniqueID | /usr/bin/awk -v id=$ID '$2 == id') ]] ||
    fail "user id $ID is taken"
  /usr/bin/dscl . -create /Users/$AGENT
  /usr/bin/dscl . -create /Users/$AGENT UniqueID $ID
  /usr/bin/dscl . -create /Users/$AGENT PrimaryGroupID $ID
  /usr/bin/dscl . -create /Users/$AGENT NFSHomeDirectory $AGENT_HOME
  print "  created"
fi
/usr/bin/dscl . -create /Users/$AGENT RealName "Console agent"
# No login shell: the account can never log in (SSH, screen, su). The
# launcher runs programs directly.
/usr/bin/dscl . -create /Users/$AGENT UserShell /usr/bin/false
/usr/bin/dscl . -create /Users/$AGENT IsHidden 1
# No password at all: the account is used only through sudo, so there is
# nothing to know, guess or see in the process list. Any earlier password
# (or other authentication) is removed on every run.
# (Only --force reaches here with agent programs running.)
/usr/bin/pkill -KILL -U $AGENT 2>/dev/null || true
/usr/bin/dscl . -delete /Users/$AGENT AuthenticationAuthority 2>/dev/null || true
/usr/bin/dscl . -create /Users/$AGENT Password '*'
for group in admin staff wheel; do
  /usr/sbin/dseditgroup -o checkmember -m $AGENT $group >/dev/null 2>&1 &&
    fail "'$AGENT' is a member of '$group'; remove it first: sudo dseditgroup -o edit -d $AGENT -t user $group"
done

step "Stopping any running agent programs before touching their folders"
/usr/bin/pkill -KILL -U $AGENT 2>/dev/null || true

step "The agent's folders"
# Root changes ownership here, so nothing on these paths may be a symbolic
# link: an agent could otherwise point one at a system folder.
# -h acts on the path itself, never on what a link points to.
plain_dir() {
  [[ ! -L $1 ]] || fail "$1 is a symbolic link; remove it and run again"
  [[ ! -e $1 || -d $1 ]] || fail "$1 exists and is not a folder; remove it and run again"
}
plain_dir $AGENT_HOME
[[ -d $AGENT_HOME ]] || /usr/sbin/createhomedir -c -u $AGENT >/dev/null 2>&1 || true
[[ -d $AGENT_HOME ]] || /bin/mkdir -m 750 $AGENT_HOME
plain_dir $AGENT_HOME
/usr/sbin/chown -h $AGENT:$AGENT $AGENT_HOME
/bin/chmod -h 750 $AGENT_HOME
for dir in .tmp work projects; do
  plain_dir $AGENT_HOME/$dir
  [[ -d $AGENT_HOME/$dir ]] || /bin/mkdir $AGENT_HOME/$dir
  plain_dir $AGENT_HOME/$dir
  /usr/sbin/chown -h $AGENT:$AGENT $AGENT_HOME/$dir
  /bin/chmod -h 750 $AGENT_HOME/$dir
done
/bin/chmod -h 700 $AGENT_HOME/.tmp
# No SSH keys: an agent could otherwise leave one behind for later logins.
/bin/rm -rf -- $AGENT_HOME/.ssh

step "Adding $OWNER to the '$AGENT' group (to read agents' work)"
/usr/sbin/dseditgroup -o edit -a $OWNER -t user $AGENT

step "Shared folder for per-agent settings and bundles from the worker ($SHARED)"
for dir in $SHARED $CLIENTS; do
  [[ ! -L $dir ]] || fail "$dir is a symbolic link; remove it and run again"
done
/bin/mkdir -p $SHARED
/usr/sbin/chown -h $OWNER:$AGENT $SHARED
/bin/chmod -h 750 $SHARED

step "The agent user must be able to run $node"
(cd / && sudo -u $AGENT $node --version >/dev/null 2>&1) ||
  fail "the '$AGENT' user cannot run $node (is it inside your home folder?); install Node 24 with Homebrew or the official installer"

step "Installing Claude Code $CLAUDE_VERSION, Codex $CODEX_VERSION and the ACP clients in $CLIENTS"
# Each client installs from its committed lockfile (scripts/console/clients/
# <name>, kept equal to clients.ts by a test), so every dependency is the
# one reviewed. npm and the clients' own install scripts run as '$AGENT', in
# a staging folder, never as root. Root then copies the result into place:
# fresh root-owned files, read-only, with no set-id bits.
/bin/mkdir -p $CLIENTS/bin
for pkg version name in @anthropic-ai/claude-code $CLAUDE_VERSION claude @openai/codex $CODEX_VERSION codex ${=acp_clients}; do
  src=$HERE/clients/$name prefix=$CLIENTS/$name-$version
  [[ -f $src/package-lock.json ]] || fail "scripts/console/clients/$name/package-lock.json is missing"
  [[ -x $prefix/node_modules/.bin/$name ]] && /usr/bin/cmp -s $src/package-lock.json $prefix/package-lock.json || {
    stage=$(/usr/bin/mktemp -d /private/tmp/console-client.XXXXXX)
    /bin/chmod 755 $stage
    /bin/mkdir $stage/home $stage/pkg
    /bin/cp $src/package.json $src/package-lock.json $stage/pkg/
    /usr/sbin/chown -R $AGENT:$AGENT $stage/home $stage/pkg
    (cd $stage/pkg && sudo -u $AGENT /usr/bin/env -i PATH=$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin \
      HOME=$stage/home TMPDIR=$stage/home/ npm_config_cache=$stage/home/.npm \
      $NODE_BIN/npm ci --no-audit --no-fund --loglevel=error >/dev/null) ||
      { /bin/rm -rf $stage; fail "npm ci for $name failed"; }
    # Anything an install script left running goes before root reads it.
    /usr/bin/pkill -KILL -U $AGENT 2>/dev/null || true
    /bin/rm -rf $prefix.new
    /usr/bin/ditto $stage/pkg $prefix.new
    /bin/rm -rf $stage
    /usr/sbin/chown -R root:wheel $prefix.new
    /bin/chmod -R a-w,ug-s $prefix.new
    [[ -z $(/usr/bin/find $prefix.new -perm +6000 -print -quit) ]] || fail "$prefix.new has set-id files"
    [[ -x $prefix.new/node_modules/.bin/$name ]] || fail "the $name install has no $name program"
    /bin/rm -rf $prefix
    /bin/mv $prefix.new $prefix
  }
  /bin/ln -sfh $prefix/node_modules/.bin/$name $CLIENTS/bin/$name
done
/usr/sbin/chown -h root:wheel $CLIENTS $CLIENTS/bin $CLIENTS/bin/*
/bin/chmod -h go-w $CLIENTS $CLIENTS/bin
# From /: the agent user cannot read the owner's folder this runs in, and
# Bun and Node clients fail to start in a folder they cannot read.
print "  $(cd / && sudo -u $AGENT $CLIENTS/bin/claude --version 2>&1 | head -1)"
print "  $(cd / && sudo -u $AGENT $CLIENTS/bin/codex --version 2>&1 | head -1)"
for line in $acp_clients; do
  name=${line##* }
  print "  $name: $(cd / && sudo -u $AGENT $CLIENTS/bin/$name --version 2>&1 | head -1)"
done

step "Installing the launcher at $LAUNCHER"
/bin/mkdir -p ${LAUNCHER:h}
# The launcher with this host's paths baked in (the defaults leave it
# byte-identical to scripts/console/console-agent). Each line must have
# been replaced: a launcher with the default paths here would quietly
# point at the wrong folders.
launcher_tmp=$(/usr/bin/mktemp)
/usr/bin/sed -e "s|^readonly AGENT_HOME=/Users/agent\$|readonly AGENT_HOME=$AGENT_HOME|" \
  -e "s|^readonly SHARED=/opt/console-shared\$|readonly SHARED=$SHARED|" \
  -e "s|^readonly CLIENTS=/opt/console-clients/bin\$|readonly CLIENTS=$CLIENTS/bin|" \
  -e "s|^readonly NODE_BIN=/opt/homebrew/bin\$|readonly NODE_BIN=$NODE_BIN|" \
  $HERE/console-agent > $launcher_tmp
for line in "AGENT_HOME=$AGENT_HOME" "SHARED=$SHARED" "CLIENTS=$CLIENTS/bin" "NODE_BIN=$NODE_BIN"; do
  /usr/bin/grep -qxF "readonly $line" $launcher_tmp || { /bin/rm -f $launcher_tmp; fail "could not set $line in the launcher (scripts/console/console-agent changed?)"; }
done
/usr/bin/install -o root -g wheel -m 755 $launcher_tmp $LAUNCHER
/bin/rm -f $launcher_tmp

step "Allowing $OWNER to run only the launcher as '$AGENT' ($SUDOERS)"
tmp=$(/usr/bin/mktemp)
cat > $tmp <<EOF
# Agent Console. The owner may run only the launcher
# as the agent user. env_reset stays on; only these credentials cross.
Defaults!$LAUNCHER env_reset
Defaults!$LAUNCHER env_keep = "CLAUDE_CODE_OAUTH_TOKEN CODEX_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY XAI_API_KEY GEMINI_API_KEY DEEPSEEK_API_KEY ZAI_API_KEY MOONSHOT_API_KEY OPENROUTER_API_KEY"
$OWNER ALL=($AGENT) NOPASSWD: $LAUNCHER
EOF
/usr/sbin/visudo -cf $tmp >/dev/null || { /bin/rm -f $tmp; fail "the sudoers rule did not validate"; }
/usr/bin/install -o root -g wheel -m 440 $tmp $SUDOERS
/bin/rm -f $tmp

step "Checking the boundary: '$AGENT' must not read the owner's files"
owner_home=$(/usr/bin/dscl . -read /Users/$OWNER NFSHomeDirectory | /usr/bin/awk '{print $2}')
failed=0
for target in $owner_home $owner_home/.ssh $owner_home/.squadroom $owner_home/GitHub; do
  if sudo -u $AGENT /bin/ls $target >/dev/null 2>&1; then
    print -P "  %F{red}READABLE%f  $target"; failed=1
  else
    print -P "  %F{green}blocked%f   $target"
  fi
done
(( failed == 0 )) || fail "the agent user can read owner files; do not continue"

step "Checking the launcher"
sudo -u $OWNER /usr/bin/sudo -n -u $AGENT $LAUNCHER spawn $AGENT_HOME /usr/bin/id -un | /usr/bin/grep -qx $AGENT ||
  fail "the launcher did not start a program as '$AGENT'"
print "  starts programs as '$AGENT'"

print -P "\n%BDone.%b Next, sign the agent account in (docs/setup.md)."
