#!/bin/sh
# Phase 1 test ttyd. Not UCI, not started at boot.
# Usage: spike-ttyd.sh start|stop|restart|status
#
# It listens on 7682 on tailscale0 only, with TLS from uhttpd, basic auth from
# /etc/grokbuild/credential (grok:<password>, mode 600), and the page in
# /usr/share/grokbuild/www/index.html.
#
# start runs a small supervisor loop in the background. Restarting tailscale
# deletes and recreates tailscale0, which takes ttyd down with it; the loop
# waits until tailscale0 has an IPv4 address again and starts a new ttyd.
#
# uhttpd keeps its certificate and key in DER, and libwebsockets only reads
# PEM, so start converts them to /etc/grokbuild/tls.crt and tls.key. The
# uhttpd files are only read.

PIDFILE=/var/run/grokbuild-ttyd.pid
CRED=/etc/grokbuild/credential
INDEX=/usr/share/grokbuild/www/index.html
IFACE=tailscale0
PORT=7682
SRC_CERT=$(uci -q get uhttpd.main.cert)
SRC_KEY=$(uci -q get uhttpd.main.key)
CERT=/etc/grokbuild/tls.crt
KEY=/etc/grokbuild/tls.key

to_pem() {
	# $1 = x509 or pkey, $2 = source, $3 = destination
	if grep -q -- '-----BEGIN' "$2" 2>/dev/null; then
		cp "$2" "$3"
	else
		openssl "$1" -inform DER -in "$2" -out "$3" || return 1
	fi
}

running() {
	[ -s "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

supervise() {
	child=
	trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT
	while :; do
		if ip -4 addr show dev "$IFACE" 2>/dev/null | grep -q 'inet '; then
			# -d 3 keeps errors and warnings only; at notice level ttyd logs the credential.
			/usr/bin/ttyd -p "$PORT" -i "$IFACE" -W \
				-c "$(cat "$CRED")" \
				-S -C "$CERT" -K "$KEY" \
				-I "$INDEX" \
				-d 3 \
				/usr/libexec/grokbuild/attach.sh &
			child=$!
			wait "$child"
			logger -t grokbuild "ttyd exited with status $?, restarting"
			child=
		fi
		sleep 3
	done
}

case "$1" in
start)
	running && { echo "already running"; exit 0; }
	[ -s "$CRED" ] || { echo "missing $CRED" >&2; exit 1; }
	[ -s "$INDEX" ] || { echo "missing $INDEX" >&2; exit 1; }
	(umask 077; to_pem x509 "$SRC_CERT" "$CERT" && to_pem pkey "$SRC_KEY" "$KEY") ||
		{ echo "cannot convert uhttpd cert/key" >&2; exit 1; }
	start-stop-daemon -S -b -m -p "$PIDFILE" -x /bin/sh -- "$0" supervise
	;;
stop)
	if running; then kill "$(cat "$PIDFILE")"; fi
	rm -f "$PIDFILE"
	;;
restart)
	"$0" stop
	sleep 1
	"$0" start
	;;
status)
	if running; then echo running; else echo stopped; fi
	;;
supervise)
	supervise
	;;
*)
	echo "usage: $0 start|stop|restart|status" >&2
	exit 1
	;;
esac
