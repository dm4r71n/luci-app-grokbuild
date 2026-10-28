#!/bin/sh
# Runs inside the tmux pane. Start grok, and when it exits fall back to a
# shell in the same pane instead of restarting it. A restart loop would spin
# on a crash or a bad login, and would hide the exit message. Type `grok` to
# start it again, or `exit` to end the session (the next attach makes a new one).
# GROKBUILD_COMMAND overrides the configured command; tests use it.

WORKDIR=$(uci -q get grokbuild.main.workdir)
CMD=${GROKBUILD_COMMAND:-$(uci -q get grokbuild.main.command)}
cd "${WORKDIR:-/root/grok-work}" || cd /root

# Job control puts grok in its own foreground process group, so tmux reports
# pane_current_command as grok rather than sh.
set -m

"${CMD:-/root/.grok/bin/grok}"
rc=$?

printf '\n[grokbuild] grok exited (status %s). Type grok to start it again.\n' "$rc"
exec /bin/ash -l
