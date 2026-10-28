#!/bin/sh
# Session control for the LuCI page (called by rpcd, see grokbuild.uc).
#   ctl.sh status            one line of JSON about the tmux session
#   ctl.sh restart-session   kill the grok session and start a fresh one
# Attached browsers see their socket close and reconnect to the new session.

# GROKBUILD_SOCKET is for tests only (a separate tmux server).
T="tmux -u -f /etc/grokbuild/tmux.conf -L ${GROKBUILD_SOCKET:-grokbuild}"

status() {
	if $T has-session -t grok 2>/dev/null; then
		$T display -p -t grok \
			'#{session_created} #{session_attached} #{pane_dead} #{pane_current_command}' |
		{
			read -r created clients dead cmd
			cmd=$(printf '%s' "$cmd" | tr -cd 'A-Za-z0-9._+-')
			printf '{"session":true,"created":%d,"clients":%d,"dead":%s,"command":"%s"}\n' \
				"${created:-0}" "${clients:-0}" "$([ "$dead" = 1 ] && echo true || echo false)" "$cmd"
		}
	else
		echo '{"session":false}'
	fi
}

case "$1" in
status)
	status
	;;
restart-session)
	$T kill-session -t grok 2>/dev/null
	/usr/libexec/grokbuild/attach.sh detached
	status
	;;
*)
	echo "usage: $0 status|restart-session" >&2
	exit 1
	;;
esac
