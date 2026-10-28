#!/bin/sh
# Attach to the Grok Build tmux session, creating it on first use.
# ttyd runs this once per browser client. Closing the browser only
# detaches the tmux client; the session and grok keep running.
#
# attach.sh            attach (what ttyd runs)
# attach.sh detached   create the session without a client if it is missing

export HOME=/root
export PATH=/root/.grok/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8

WORKDIR=$(uci -q get grokbuild.main.workdir)
WORKDIR=${WORKDIR:-/root/grok-work}
mkdir -p "$WORKDIR"
# GROKBUILD_SOCKET is for tests only (a separate tmux server).
SOCK=${GROKBUILD_SOCKET:-grokbuild}

# -u forces UTF-8; busybox/musl has no locale for tmux to detect it from.
if [ "$1" = detached ]; then
	tmux -u -f /etc/grokbuild/tmux.conf -L "$SOCK" has-session -t grok 2>/dev/null && exit 0
	exec tmux -u -f /etc/grokbuild/tmux.conf -L "$SOCK" \
		new-session -d -s grok -x 120 -y 40 -c "$WORKDIR" /usr/libexec/grokbuild/session.sh
fi
exec tmux -u -f /etc/grokbuild/tmux.conf -L "$SOCK" \
	new-session -A -s grok -c "$WORKDIR" /usr/libexec/grokbuild/session.sh
