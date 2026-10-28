#!/bin/sh
# Phase 1 test ttyd. Not UCI, not started at boot.
# Usage: spike-ttyd.sh start|stop|restart|status
#
# ttyd's -i binds one interface, so there is one ttyd per interface, both on
# port 7682: br-lan (https://192.168.1.1:7682/) and tailscale0
# (https://100.104.188.37:7682/). Both use TLS from uhttpd, basic auth from
# /etc/grokbuild/credential (grok:<password>, mode 600), the page in
# /usr/share/grokbuild/www/index.html, and attach to the same tmux session.
# The firewall rule Block-GrokBuild-WAN rejects 7682 from the wan zone as a
# second layer.
#
# start runs one small supervisor loop per interface in the background.
# Restarting tailscale deletes and recreates tailscale0, which takes that ttyd
# down with it; its loop waits until the interface has an IPv4 address again
# and starts a new ttyd.
#
# uhttpd keeps its certificate and key in DER, and libwebsockets only reads
# PEM, so start converts them to /etc/grokbuild/tls.crt and tls.key. The
# uhttpd files are only read.

IFACES="br-lan tailscale0"
CRED=/etc/grokbuild/credential
INDEX=/usr/share/grokbuild/www/index.html
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

pidfile() {
	echo "/var/run/grokbuild-ttyd-$1.pid"
}

running() {
	[ -s "$(pidfile "$1")" ] && kill -0 "$(cat "$(pidfile "$1")")" 2>/dev/null
}

supervise() {
	iface=$1
	child=
	trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' TERM INT
	while :; do
		if ip -4 addr show dev "$iface" 2>/dev/null | grep -q 'inet '; then
			# -d 3 keeps errors and warnings only; at notice level ttyd logs the credential.
			/usr/bin/ttyd -p "$PORT" -i "$iface" -W \
				-c "$(cat "$CRED")" \
				-S -C "$CERT" -K "$KEY" \
				-I "$INDEX" \
				-d 3 \
				/usr/libexec/grokbuild/attach.sh &
			child=$!
			wait "$child"
			logger -t grokbuild "ttyd on $iface exited with status $?, restarting"
			child=
		fi
		sleep 3
	done
}

case "$1" in
start)
	[ -s "$CRED" ] || { echo "missing $CRED" >&2; exit 1; }
	[ -s "$INDEX" ] || { echo "missing $INDEX" >&2; exit 1; }
	(umask 077; to_pem x509 "$SRC_CERT" "$CERT" && to_pem pkey "$SRC_KEY" "$KEY") ||
		{ echo "cannot convert uhttpd cert/key" >&2; exit 1; }
	for i in $IFACES; do
		running "$i" && { echo "$i: already running"; continue; }
		start-stop-daemon -S -b -m -p "$(pidfile "$i")" -x /bin/sh -- "$0" supervise "$i"
	done
	;;
stop)
	for i in $IFACES; do
		running "$i" && kill "$(cat "$(pidfile "$i")")"
		rm -f "$(pidfile "$i")"
	done
	# The single-instance pid file from before the LAN instance existed.
	[ -s /var/run/grokbuild-ttyd.pid ] && kill "$(cat /var/run/grokbuild-ttyd.pid)" 2>/dev/null
	rm -f /var/run/grokbuild-ttyd.pid
	;;
restart)
	"$0" stop
	sleep 1
	"$0" start
	;;
status)
	for i in $IFACES; do
		if running "$i"; then echo "$i: running"; else echo "$i: stopped"; fi
	done
	;;
supervise)
	supervise "$2"
	;;
*)
	echo "usage: $0 start|stop|restart|status" >&2
	exit 1
	;;
esac
