#!/bin/sh
# Phase 1 spike: a second, standalone ttyd for testing. Not UCI, not started
# at boot. Usage: spike-ttyd.sh start|stop|status
#
# It listens on 7682 on tailscale0 only, with TLS from uhttpd and basic auth
# from /etc/grokbuild/credential (grok:<password>, mode 600).
#
# uhttpd keeps its certificate and key in DER, and libwebsockets only reads
# PEM, so start converts them to /etc/grokbuild/tls.crt and tls.key. The
# uhttpd files are only read.

PIDFILE=/var/run/grokbuild-ttyd.pid
LOG=/tmp/grokbuild-ttyd.log
CRED=/etc/grokbuild/credential
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

case "$1" in
start)
	[ -s "$CRED" ] || { echo "missing $CRED" >&2; exit 1; }
	(umask 077; to_pem x509 "$SRC_CERT" "$CERT" && to_pem pkey "$SRC_KEY" "$KEY") ||
		{ echo "cannot convert uhttpd cert/key" >&2; exit 1; }
	start-stop-daemon -S -b -m -p "$PIDFILE" -x /usr/bin/ttyd -- \
		-p 7682 -i tailscale0 -W \
		-c "$(cat "$CRED")" \
		-S -C "$CERT" -K "$KEY" \
		-t titleFixed="Grok Build" \
		-d 3 \
		/usr/libexec/grokbuild/attach.sh
	;;
stop)
	start-stop-daemon -K -p "$PIDFILE" -x /usr/bin/ttyd && rm -f "$PIDFILE"
	;;
status)
	start-stop-daemon -K -t -p "$PIDFILE" -x /usr/bin/ttyd >/dev/null && echo running || echo stopped
	;;
*)
	echo "usage: $0 start|stop|status" >&2
	exit 1
	;;
esac
