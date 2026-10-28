#!/bin/sh
# Attach to the Grok Build tmux session, creating it on first use.
# ttyd runs this once per browser client. Closing the browser only
# detaches the tmux client; the session and grok keep running.

export HOME=/root
export PATH=/root/.grok/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LANG=C.UTF-8

mkdir -p /root/grok-work

# -u forces UTF-8; busybox/musl has no locale for tmux to detect it from.
exec tmux -u -f /etc/grokbuild/tmux.conf -L grokbuild \
	new-session -A -s grok -c /root/grok-work /usr/libexec/grokbuild/session.sh
